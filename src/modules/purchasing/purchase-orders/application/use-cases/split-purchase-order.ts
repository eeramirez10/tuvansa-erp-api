import { createHash } from 'node:crypto';
import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import { ConflictError } from '../../../../../shared/domain/errors/conflict-error.js';
import { NotFoundError } from '../../../../../shared/domain/errors/not-found-error.js';
import type { PurchaseOrderCreateLegacyDataSource, PurchaseOrderCreateStorage } from '../../domain/datasources/purchase-order-create-data-source.js';
import type { PurchaseOrderEditLegacyDataSource, PurchaseOrderEditStorage } from '../../domain/datasources/purchase-order-edit-data-source.js';
import type { PurchaseOrderSplitInput, PurchaseOrderSplitLegacy, PurchaseOrderSplitStorage } from '../../domain/datasources/purchase-order-split-data-source.js';
import { purchaseOrderStockDifference, totalizePurchaseOrder } from '../../domain/entities/purchase-order-edit.js';
import type { PurchaseOrderLine, PurchaseOrderProps } from '../../domain/entities/purchase-order.js';
import type { PurchaseOrdersRepository } from '../../domain/repositories/purchase-orders-repository.js';
import { loadPurchaseOrderWriteContext } from './load-purchase-order-write-context.js';

const lineReason = (line: PurchaseOrderLine, withPieces: Set<string>) => {
  if (!line.productCode) return 'La partida no tiene un producto.';
  if (line.fulfilled !== 0 || line.assigned !== 0) return 'La partida tiene surtido o asignación.';
  if (withPieces.has(line.productCode)) return 'El producto tiene piezas asociadas a esta orden.';
  return '';
};

export class SplitPurchaseOrder {
  constructor(
    private readonly legacy: PurchaseOrderEditLegacyDataSource & Pick<PurchaseOrderCreateLegacyDataSource, 'creationDefaults'> & PurchaseOrderSplitLegacy,
    private readonly storage: PurchaseOrderEditStorage & PurchaseOrderCreateStorage & PurchaseOrderSplitStorage,
    private readonly orders: PurchaseOrdersRepository,
  ) {}

  private async context(id: number) {
    const [context, pieces] = await Promise.all([
      loadPurchaseOrderWriteContext(id, this.legacy, this.storage, this.storage),
      this.orders.getPanel(id, 'pieces'),
    ]);
    const { base, rules, documentKind, lines, stored, version } = context;
    const withPieces = new Set((pieces?.items ?? []).map(({ productCode }) => String(productCode ?? '')));
    let reason = '';
    if (documentKind !== 'order') reason = 'Split está habilitado para pedidos de compra.';
    else if (rules.companyId !== rules.activeCompanyId) reason = 'La orden pertenece a otra compañía.';
    else if (stored && stored.legacyVersion !== version) reason = 'La orden de origen cambió.';
    else if (base.number.length >= 15) reason = 'El folio no tiene espacio para un sufijo.';
    else if (!lines.some((line) => !lineReason(line, withPieces))) reason = 'La orden no tiene partidas disponibles para mover.';
    else if (!this.storage.writable()) reason = 'Split requiere PostgreSQL.';
    return { ...context, reason, withPieces };
  }

  async get(id: number) {
    const { base, stored, version, reason, lines, withPieces } = await this.context(id);
    return {
      id, number: base.number, revision: stored?.revision ?? 0, legacyVersion: version, reason, canWrite: !reason,
      lines: lines.map((line) => {
        const { id, productCode, description, ordered, fulfilled, assigned } = line;
        const reason = lineReason(line, withPieces);
        return { id, productCode, description, ordered, fulfilled, assigned, reason, canSplit: !reason };
      }),
    };
  }

  async execute(id: number, input: PurchaseOrderSplitInput) {
    if (!this.storage.writable()) throw new ApplicationError('Split requiere PostgreSQL.', 'PURCHASE_ORDER_POSTGRES_UNAVAILABLE', 503);
    const fingerprint = createHash('sha256').update(JSON.stringify({ id, ...input, lineIds: input.lineIds.toSorted((a, b) => a - b) })).digest('hex');
    const prior = await this.storage.findLocalRequest(input.requestKey, fingerprint);
    if (prior) return this.readSaved(prior.id);

    const { base, stored, version, lines, rules, reason, documentKind, local, withPieces } = await this.context(id);
    if (input.revision !== (stored?.revision ?? 0) || input.legacyVersion !== version) {
      throw new ConflictError('La orden cambió. Vuelve a abrir Split.', 'PURCHASE_ORDER_SPLIT_STALE');
    }
    if (reason) throw new ApplicationError(reason, 'PURCHASE_ORDER_SPLIT_NOT_ALLOWED', 409);
    const selected = new Set(input.lineIds);
    const moved = lines.filter((line) => selected.has(line.id));
    if (moved.length === 0 || moved.length !== input.lineIds.length || moved.some((line) => lineReason(line, withPieces))) {
      throw new ApplicationError('Selecciona partidas disponibles para mover.', 'INVALID_PURCHASE_ORDER_SPLIT_LINES', 422);
    }
    const [entry, products, references, defaults, currencyName] = await Promise.all([
      this.orders.findById(id),
      this.legacy.findProducts([...new Set(lines.map(({ productCode }) => productCode))], rules.supplierUnits),
      this.legacy.splitReferences(id, base.number),
      this.legacy.creationDefaults(),
      this.legacy.commentCurrencyName(1),
    ]);
    if (!entry) throw new NotFoundError('Orden de compra');
    const current = entry.toPrimitives();
    const taxable = new Map(products.map((product) => [product.id, product.taxable]));
    if (lines.some(({ productId }) => !taxable.has(productId))) {
      throw new ApplicationError('Falta el producto de una partida para recalcular los importes.', 'PURCHASE_ORDER_SPLIT_PRODUCT_UNAVAILABLE', 422);
    }
    const lineIsTaxable = ({ productId }: PurchaseOrderLine) => taxable.get(productId) === true;
    const parentLines = lines.filter((line) => !selected.has(line.id));
    const childLines = moved.map((line) => ({ ...line, currencyId: 1, currencyName }));
    const childHeader: Omit<PurchaseOrderProps, 'id' | 'number'> = {
      supplierOrderNumber: current.supplierOrderNumber, supplier: current.supplier, supplierParameter: current.supplier.code,
      documentKind: 'order', status: '', received: { quantity: 0, pieces: 0 },
      branch: 0, department: '', dates: current.dates, warehouse: current.warehouse, initial: false,
      taxPercentage: current.taxPercentage, discountPercentages: [0, 0, 0], otherLabel: '', classifications: Array.from({ length: 9 }, () => ''),
      totals: { assigned: 0, ordered: 0, fulfilled: 0, remaining: 0, subtotal: 0, discount: 0, exciseTax: 0,
        freight: 0, insurance: 0, other: 0, tax: 0, total: 0 }, lines: [],
    };
    const childBase = { ...childHeader, id: 0, number: '' };
    const parentStock = purchaseOrderStockDifference(base, parentLines, documentKind).map((item) => local && item.pending > 0
      ? { ...item, nextReceiptAt: current.dates.from } : item);
    const saved = await this.storage.saveSplit(input.requestKey, fingerprint, {
      id, number: base.number, revision: input.revision, legacyVersion: version, lines: parentLines,
      ...totalizePurchaseOrder(current, parentLines, lineIsTaxable),
    }, parentStock, {
      header: childHeader,
      document: { lines: childLines, ...totalizePurchaseOrder(childBase, childLines, lineIsTaxable) },
      metadata: {
        rules: { ...rules, currencyId: 1, currencyName, supplierCode: current.supplier.code },
        terms: 0, taxType: 0, onAccount: 0, exchangeRate: 1, labels: defaults?.labels ?? [], createdAt: defaults?.today ?? '',
      },
      stock: purchaseOrderStockDifference(childBase, childLines).map((item) => ({
        ...item, nextReceiptAt: item.pending > 0 ? childHeader.dates.from : null,
      })),
    }, references);
    return this.readSaved(saved.id);
  }

  private async readSaved(id: number) {
    const order = await this.orders.findById(id);
    if (!order) throw new NotFoundError('Orden de compra');
    return order.toPrimitives();
  }
}
