import { createHash } from 'node:crypto';
import { NotFoundError } from '../../../../../shared/domain/errors/not-found-error.js';
import type { PurchaseOrderCreateStorage } from '../../domain/datasources/purchase-order-create-data-source.js';
import type {
  PurchaseOrderEditLegacyDataSource, PurchaseOrderEditRules, PurchaseOrderEditStorage,
} from '../../domain/datasources/purchase-order-edit-data-source.js';
import type { PurchaseOrderProps } from '../../domain/entities/purchase-order.js';

function legacyVersion(order: PurchaseOrderProps, rules: PurchaseOrderEditRules) {
  const { ordered, fulfilled, assigned, remaining, ...money } = order.totals;
  return createHash('sha256').update(JSON.stringify({
    id: order.id, number: order.number, type: order.documentKind, supplierId: order.supplier.id,
    rules, dates: order.dates, warehouse: order.warehouse, discounts: order.discountPercentages,
    taxPercentage: order.taxPercentage, money, ordered, fulfilled, assigned, remaining,
    lines: order.lines.map(({ description: _description, currencyName: _currencyName, supplierProductCode: _supplierProductCode, ...line }) => line),
  })).digest('hex');
}

export async function loadPurchaseOrderWriteContext(
  id: number, legacy: PurchaseOrderEditLegacyDataSource, storage: PurchaseOrderEditStorage, creation: PurchaseOrderCreateStorage,
) {
  const local = await creation.findLocal(id);
  const [source, rules, savedOrders, removed] = await Promise.all([
    local?.order ?? legacy.findById(id),
    local?.metadata.rules ?? legacy.rules(id),
    storage.find([id]),
    storage.findRemoved([id]),
  ]);
  if (!source || !rules || removed.some(({ number }) => number === source.identity.number)) {
    throw new NotFoundError('Orden de compra');
  }
  const base = source.toPrimitives();
  const stored = savedOrders.find((item) => item.number === base.number);
  const version = local?.fingerprint ?? legacyVersion(base, rules);
  const lines = stored?.lines ?? base.lines;
  return { base, rules, stored, version, lines, local };
}
