import { createHash } from 'node:crypto';
import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import { ConflictError } from '../../../../../shared/domain/errors/conflict-error.js';
import { NotFoundError } from '../../../../../shared/domain/errors/not-found-error.js';
import type {
  PurchaseOrderEditInput, PurchaseOrderEditLegacyDataSource, PurchaseOrderEditStorage,
} from '../../domain/datasources/purchase-order-edit-data-source.js';
import type { PurchaseOrderCreateStorage } from '../../domain/datasources/purchase-order-create-data-source.js';
import type { PurchaseOrderSupplierChangeStorage } from '../../domain/datasources/purchase-order-supplier-change-data-source.js';
import { buildPurchaseOrderEdit, displayPurchaseOrderEditLines, productEditOptions } from '../../domain/entities/purchase-order-edit.js';
import type { PurchaseOrdersRepository } from '../../domain/repositories/purchase-orders-repository.js';
import { loadPurchaseOrderWriteContext } from './load-purchase-order-write-context.js';

const stale = () => new ConflictError('La orden cambió desde que abriste el editor. Vuelve a abrirlo.', 'PURCHASE_ORDER_EDIT_STALE');

export class EditPurchaseOrder {
  constructor(
    private readonly legacy: PurchaseOrderEditLegacyDataSource,
    private readonly storage: PurchaseOrderEditStorage & Pick<PurchaseOrderSupplierChangeStorage, 'findSupplierChanges'>,
    private readonly orders: PurchaseOrdersRepository,
    private readonly creation: PurchaseOrderCreateStorage,
  ) {}

  private async context(id: number) {
    const [context, changes] = await Promise.all([
      loadPurchaseOrderWriteContext(id, this.legacy, this.storage, this.creation), this.storage.findSupplierChanges([id]),
    ]);
    const { base, rules, lines, stored, version } = context;
    const change = changes.find(({ number }) => number === base.number);
    let reason = '';
    if (base.documentKind !== 'order') reason = 'Omnis permite editar partidas desde esta ventana sólo para pedidos.';
    else if (rules.companyId !== rules.activeCompanyId) reason = 'La orden pertenece a otra compañía.';
    else if (stored && stored.legacyVersion !== version) {
      reason = 'La orden de origen cambió después de la edición en PostgreSQL.';
    } else if (lines.some((line) => line.assigned !== 0)) reason = 'Desconfirma las partidas antes de editar la orden.';
    else if (!this.storage.writable()) reason = 'El guardado de órdenes requiere PostgreSQL.';
    return {
      ...context, reason, change,
      rules: change ? { ...rules, supplierCode: change.supplier.code, supplierDiscounts: change.supplierDiscounts } : rules,
      editVersion: change ? createHash('sha256').update(`${version}/supplier/${change.revision}`).digest('hex') : version,
    };
  }

  async get(id: number) {
    const editor = await this.context(id);
    const { base, lines, rules, stored, editVersion, reason } = editor;
    return {
      id, number: base.number, revision: stored?.revision ?? 0, legacyVersion: editVersion,
      canWrite: reason === '', priceLocked: rules.priceLocked, supplierUnits: rules.supplierUnits, reason,
      lines: displayPurchaseOrderEditLines(lines),
    };
  }

  async products(id: number, query: string) {
    const local = await this.creation.findLocal(id);
    const [removed, changes] = await Promise.all([this.storage.findRemoved([id]), this.storage.findSupplierChanges([id])]);
    let change;
    if (removed.length > 0 || changes.length > 0) {
      const current = local?.order ?? await this.legacy.findById(id);
      if (!current || removed.some(({ number }) => number === current.identity.number)) throw new NotFoundError('Orden de compra');
      change = changes.find(({ number }) => number === current.identity.number);
    }
    const rules = local?.metadata.rules ?? await this.legacy.rules(id);
    if (!rules) throw new NotFoundError('Orden de compra');
    const effective = change ? { ...rules, supplierCode: change.supplier.code, supplierDiscounts: change.supplierDiscounts } : rules;
    return (await this.legacy.searchProducts(query, rules.supplierUnits)).map((product) => productEditOptions(product, effective));
  }

  async save(id: number, input: PurchaseOrderEditInput) {
    const { base, rules, lines, stored, version, editVersion, reason, local, change } = await this.context(id);
    if (input.revision !== (stored?.revision ?? 0) || input.legacyVersion !== editVersion ||
      (stored && stored.legacyVersion !== version)) throw stale();
    if (reason) throw new ApplicationError(reason, 'PURCHASE_ORDER_EDIT_NOT_ALLOWED', this.storage.writable() ? 409 : 503);

    const codes = [...new Set(input.lines.map((line) => line.productCode).filter(Boolean))];
    const products = await this.legacy.findProducts(codes, rules.supplierUnits);
    const update = buildPurchaseOrderEdit(base, lines, input, rules, products,
      local ? { initial: false, supplierTaxType: change?.taxType ?? local.metadata.taxType } : undefined);
    if (update) {
      const { stock, ...document } = update;
      const changes = local ? stock.map((item) => ({ ...item, nextReceiptAt: item.pending > 0 ? base.dates.from : null })) : stock;
      await this.storage.save({ id, number: base.number, legacyVersion: version, revision: input.revision, ...document }, changes, change?.revision ?? 0);
    }
    const saved = await this.orders.findById(id);
    if (!saved) throw new NotFoundError('Orden de compra');
    return saved.toPrimitives();
  }
}
