import { createHash } from 'node:crypto';
import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import { ConflictError } from '../../../../../shared/domain/errors/conflict-error.js';
import { NotFoundError } from '../../../../../shared/domain/errors/not-found-error.js';
import type {
  PurchaseOrderEditInput, PurchaseOrderEditLegacyDataSource, PurchaseOrderEditRules, PurchaseOrderEditStorage,
} from '../../domain/datasources/purchase-order-edit-data-source.js';
import { buildPurchaseOrderEdit, displayPurchaseOrderEditLines, productEditOptions } from '../../domain/entities/purchase-order-edit.js';
import type { PurchaseOrderProps } from '../../domain/entities/purchase-order.js';
import type { PurchaseOrdersRepository } from '../../domain/repositories/purchase-orders-repository.js';

const stale = () => new ConflictError('La orden cambió desde que abriste el editor. Vuelve a abrirlo.', 'PURCHASE_ORDER_EDIT_STALE');

function legacyVersion(order: PurchaseOrderProps, rules: PurchaseOrderEditRules) {
  const { ordered, fulfilled, assigned, remaining, ...money } = order.totals;
  return createHash('sha256').update(JSON.stringify({
    id: order.id, number: order.number, type: order.documentKind, supplierId: order.supplier.id,
    rules, dates: order.dates, warehouse: order.warehouse, discounts: order.discountPercentages,
    taxPercentage: order.taxPercentage, money, ordered, fulfilled, assigned, remaining,
    lines: order.lines.map(({ description: _description, currencyName: _currencyName, supplierProductCode: _supplierProductCode, ...line }) => line),
  })).digest('hex');
}

export class EditPurchaseOrder {
  constructor(
    private readonly legacy: PurchaseOrderEditLegacyDataSource,
    private readonly storage: PurchaseOrderEditStorage,
    private readonly orders: PurchaseOrdersRepository,
  ) {}

  private async context(id: number) {
    const [source, rules, savedOrders] = await Promise.all([this.legacy.findById(id), this.legacy.rules(id), this.storage.find([id])]);
    if (!source || !rules) throw new NotFoundError('Orden de compra');
    const base = source.toPrimitives();
    const stored = savedOrders.find((item) => item.number === base.number);
    const version = legacyVersion(base, rules);
    const lines = stored?.lines ?? base.lines;
    let reason = '';
    if (base.documentKind !== 'order') reason = 'Omnis permite editar partidas desde esta ventana sólo para pedidos.';
    else if (rules.companyId !== rules.activeCompanyId) reason = 'La orden pertenece a otra compañía.';
    else if (base.totals.assigned !== 0 || lines.some((line) => line.assigned !== 0)) {
      reason = 'Desconfirma las partidas antes de editar la orden.';
    } else if (stored && stored.legacyVersion !== version) {
      reason = 'La orden de origen cambió después de la edición en PostgreSQL.';
    } else if (!this.storage.writable()) reason = 'El guardado de órdenes requiere PostgreSQL.';
    return { base, rules, lines, stored, version, reason };
  }

  async get(id: number) {
    const editor = await this.context(id);
    const { base, lines, rules, stored, version, reason } = editor;
    return {
      id, number: base.number, revision: stored?.revision ?? 0, legacyVersion: version,
      canWrite: reason === '', priceLocked: rules.priceLocked, supplierUnits: rules.supplierUnits, reason,
      lines: displayPurchaseOrderEditLines(lines),
    };
  }

  async products(id: number, query: string) {
    const rules = await this.legacy.rules(id);
    if (!rules) throw new NotFoundError('Orden de compra');
    return (await this.legacy.searchProducts(query, rules.supplierUnits)).map((product) => productEditOptions(product, rules));
  }

  async save(id: number, input: PurchaseOrderEditInput) {
    const { base, rules, lines, stored, version, reason } = await this.context(id);
    if (input.revision !== (stored?.revision ?? 0) || input.legacyVersion !== version ||
      (stored && stored.legacyVersion !== version)) throw stale();
    if (reason) throw new ApplicationError(reason, 'PURCHASE_ORDER_EDIT_NOT_ALLOWED', this.storage.writable() ? 409 : 503);

    const codes = [...new Set(input.lines.map((line) => line.productCode).filter(Boolean))];
    const products = await this.legacy.findProducts(codes, rules.supplierUnits);
    const update = buildPurchaseOrderEdit(base, lines, input, rules, products);
    if (update) {
      const { stock, ...document } = update;
      await this.storage.save({ id, number: base.number, legacyVersion: version, revision: input.revision, ...document }, stock);
    }
    const saved = await this.orders.findById(id);
    if (!saved) throw new NotFoundError('Orden de compra');
    return saved.toPrimitives();
  }
}
