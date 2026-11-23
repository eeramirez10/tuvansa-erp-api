import { createHash } from 'node:crypto';
import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import { ConflictError } from '../../../../../shared/domain/errors/conflict-error.js';
import { NotFoundError } from '../../../../../shared/domain/errors/not-found-error.js';
import type { PurchaseOrderCreateLegacyDataSource, PurchaseOrderCreateStorage } from '../../domain/datasources/purchase-order-create-data-source.js';
import type { PurchaseOrderDuplicateFields, PurchaseOrderDuplicateInput, PurchaseOrderDuplicateStorage } from '../../domain/datasources/purchase-order-duplicate-data-source.js';
import type { PurchaseOrderEditLegacyDataSource, PurchaseOrderEditStorage } from '../../domain/datasources/purchase-order-edit-data-source.js';
import { purchaseOrderStockDifference, totalizePurchaseOrder } from '../../domain/entities/purchase-order-edit.js';
import type { PurchaseOrdersRepository } from '../../domain/repositories/purchase-orders-repository.js';
import type { EditPurchaseOrderComments } from './edit-purchase-order-comments.js';
import { loadPurchaseOrderWriteContext } from './load-purchase-order-write-context.js';

const invalid = (message: string) => new ApplicationError(message, 'INVALID_PURCHASE_ORDER_DUPLICATE', 422);

export class DuplicatePurchaseOrder {
  constructor(
    private readonly legacy: PurchaseOrderEditLegacyDataSource & PurchaseOrderCreateLegacyDataSource,
    private readonly storage: PurchaseOrderEditStorage & PurchaseOrderCreateStorage & PurchaseOrderDuplicateStorage,
    private readonly orders: PurchaseOrdersRepository,
    private readonly comments: Pick<EditPurchaseOrderComments, 'get'>,
  ) {}

  private async context(id: number, markedOnly: boolean) {
    const [source, effective, defaults] = await Promise.all([
      loadPurchaseOrderWriteContext(id, this.legacy, this.storage, this.storage),
      this.orders.findById(id),
      this.legacy.creationDefaults(),
    ]);
    if (!effective) throw new NotFoundError('Orden de compra');
    const current = effective.toPrimitives();
    const { rules, stored, version, documentKind } = source;
    const selected = source.lines.filter(({ productCode, classCode }) => productCode && (!markedOnly || classCode === 'X'));
    let reason = '';
    if (!defaults) reason = 'El movimiento O no está disponible para compras.';
    else if (rules.companyId !== rules.activeCompanyId) reason = 'El documento pertenece a otra compañía.';
    else if (documentKind === 'unknown') reason = 'El documento no es un pedido ni una cotización.';
    else if (!selected.length) reason = markedOnly ? 'No hay partidas marcadas con X.' : 'El documento no tiene partidas.';
    else if (stored && stored.legacyVersion !== version) reason = 'El documento de origen cambió.';
    else if (!this.storage.writable()) reason = 'Duplicar requiere PostgreSQL.';
    return { ...source, current, reason, selected, defaults };
  }

  async get(id: number, markedOnly: boolean) {
    const { current, stored, version, selected, reason, defaults } = await this.context(id, markedOnly);
    const fields: PurchaseOrderDuplicateFields = {
      supplierCode: current.supplier.code, percentage: 100, orderedAt: defaults?.today ?? '', from: current.dates.from,
      supplierOrderNumber: current.supplierOrderNumber, branchCode: current.classifications[2]?.replace(/^3/, '') ?? '',
    };
    return { id, number: current.number, revision: stored?.revision ?? 0, legacyVersion: version, canWrite: !reason, reason,
      lineCount: selected.length, fields };
  }

  async execute(sourceId: number, input: PurchaseOrderDuplicateInput) {
    if (!this.storage.writable()) throw new ApplicationError('Duplicar requiere PostgreSQL.', 'PURCHASE_ORDER_POSTGRES_UNAVAILABLE', 503);
    const fingerprint = createHash('sha256').update(JSON.stringify({ sourceId, ...input })).digest('hex');
    const prior = await this.storage.findLocalRequest(input.requestKey, fingerprint);
    if (prior) return this.readSaved(prior.id);

    const { current, stored, version, reason, selected, defaults, rules, lines: sourceLines } = await this.context(sourceId, input.markedOnly);
    if (input.revision !== (stored?.revision ?? 0) || input.legacyVersion !== version) {
      throw new ConflictError('El documento cambió. Vuelve a abrir Duplicar.', 'PURCHASE_ORDER_DUPLICATE_STALE');
    }
    if (reason || !defaults) throw new ApplicationError(reason, 'PURCHASE_ORDER_DUPLICATE_NOT_ALLOWED', 409);
    const { supplierCode, orderedAt, from, supplierOrderNumber, percentage, branchCode } = input.fields;
    const [choices, products, comments] = await Promise.all([
      this.legacy.creationSuppliers(supplierCode, true),
      this.legacy.findProducts([...new Set(selected.map(({ productCode }) => productCode))], rules.supplierUnits),
      this.comments.get(sourceId),
    ]);
    const supplier = choices[0];
    if (!supplier) throw new NotFoundError('Proveedor activo');
    const byId = new Map(products.map((product) => [product.id, product]));
    if (selected.some(({ productId }) => !byId.has(productId))) throw invalid('Falta el producto de una partida.');
    const lines = selected.map((line) => {
      const product = byId.get(line.productId)!;
      const ordered = Math.round(line.ordered * percentage * 10) / 1000;
      if (!Number.isSafeInteger(Math.round(ordered * 1000))) throw invalid('La cantidad duplicada excede el rango.');
      return {
        ...line, id: 0, ordered, fulfilled: 0, remaining: ordered, confirmed: false, assigned: 0,
        supplierProductCode: product.supplierProductCode,
      };
    });
    if (!lines.some(({ ordered }) => ordered > 0)) throw invalid('Las cantidades duplicadas quedaron en cero.');
    const classifications = Array.from({ length: 9 }, (_, index) => current.classifications[index] ?? '');
    classifications[2] = branchCode ? `3${branchCode}` : '';
    classifications[8] = '';
    const { id, number, ...header } = current;
    const duplicateHeader = {
      ...header, lines: [], supplier: supplier.supplier, supplierParameter: supplier.supplier.code,
      classifications, status: '', initial: false, documentKind: 'order' as const, supplierOrderNumber,
      dates: { ...header.dates, orderedAt, from }, received: { quantity: 0, pieces: 0 },
    };
    const duplicateBase = { ...duplicateHeader, id: 0, number: '' };
    const totals = totalizePurchaseOrder(duplicateBase, lines, ({ productId }) => Boolean(byId.get(productId)?.taxable));
    const saved = await this.storage.saveDuplicate(input.requestKey, fingerprint, {
      id, number, revision: input.revision, legacyVersion: version, lines: sourceLines,
      totals: current.totals, amountInWords: stored?.amountInWords ?? null,
    }, {
      header: duplicateHeader,
      document: { lines, ...totals, comments: {
        fields: { ...comments.fields, from, supplierOrderNumber, confirmedAt: null },
        currencyName: stored?.comments?.currencyName ?? rules.currencyName, manualConfirmation: null,
      } },
      metadata: {
        rules: {
          ...rules, currencyId: comments.fields.currencyId, currencyName: stored?.comments?.currencyName ?? rules.currencyName,
          supplierCode: supplier.supplier.code, supplierDiscounts: supplier.rules.supplierDiscounts,
        },
        terms: comments.fields.terms, exchangeRate: comments.fields.exchangeRate, taxType: supplier.taxType, onAccount: 0,
        labels: defaults.labels, createdAt: defaults.today,
      },
      stock: purchaseOrderStockDifference(duplicateBase, lines),
    });
    return this.readSaved(saved.id);
  }

  private async readSaved(id: number) {
    const order = await this.orders.findById(id);
    if (!order) throw new NotFoundError('Orden de compra');
    return order.toPrimitives();
  }
}
