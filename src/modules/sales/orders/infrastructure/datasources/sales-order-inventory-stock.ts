import type { RowDataPacket } from 'mysql2/promise';
import { ConflictError } from '../../../../../shared/domain/errors/conflict-error.js';
import { legacyMysqlPool } from '../../../../../shared/infrastructure/database/legacy-mysql-pool.js';
import { connectPostgres, postgresConfigured, type PostgresClient } from '../../../../../shared/infrastructure/database/postgres-pool.js';
import { catalogProductsById } from '../../../../inventories/products/infrastructure/datasources/product-catalog-references.js';
import { normalizeOrderWarehouse } from '../../domain/entities/order-warehouse.js';
import type { OrderProps } from '../../domain/entities/order.js';

interface LegacyStock {
  productId: number;
  unit: string;
  onHand: number;
  assigned: number;
}

export type SaleStockRequest = { productId: number; quantity: number; legacyOnHand: number; legacyAssigned: number };
export const scaledStock = (value: number) => Number(value.toFixed(3));

export async function readLegacySaleStock(warehouse: string, products: number[]): Promise<Map<number, LegacyStock>> {
  if (!products.length) return new Map<number, LegacyStock>();
  const [rows] = await legacyMysqlPool.execute<Array<RowDataPacket & LegacyStock>>(
    `SELECT I.ISEQ AS productId,I.IUM AS unit,COALESCE(SUM(A.ALMCANT),0) AS onHand,COALESCE(SUM(A.ALMASIGNADO),0) AS assigned
      FROM FINV I LEFT JOIN FALM A ON A.ISEQ=I.ISEQ AND A.ALMNUM=?
      WHERE I.ISEQ IN (${products.map(() => '?').join(',')}) GROUP BY I.ISEQ,I.IUM`,
    [warehouse, ...products],
  );
  return new Map(rows.map((row) => [row.productId, row]));
}

export const hasLocalSalesStock = async (client: PostgresClient) => {
  const { rows: [tables] } = await client.query<{ orders: boolean; receipts: boolean; remissions: boolean; receiptCancellations: boolean;
    remissionCancellations: boolean; adjustments: boolean }>(
    `SELECT to_regclass('tuvansa.orders') IS NOT NULL AS orders,
            to_regclass('tuvansa.purchase_reception_inventory') IS NOT NULL AS receipts,
            to_regclass('tuvansa.sales_remission_inventory') IS NOT NULL AS remissions,
            to_regclass('tuvansa.purchase_reception_cancellation_inventory') IS NOT NULL AS "receiptCancellations",
            to_regclass('tuvansa.sales_remission_cancellation_inventory') IS NOT NULL AS "remissionCancellations",
            to_regclass('tuvansa.inventory_adjustment_stock') IS NOT NULL AS adjustments`,
  );
  return tables ?? { orders: false, receipts: false, remissions: false, receiptCancellations: false, remissionCancellations: false, adjustments: false };
};

export async function localOrderAssignmentRows(client: PostgresClient, products: number[], warehouse: string | null = null, excludeOrderId: number | null = null) {
  const { rows } = await client.query<{ productId: string; warehouse: string; assigned: string }>(
    `WITH documents AS (
       SELECT document AS data,1 AS sign FROM tuvansa.orders WHERE deleted_at IS NULL AND ($3::bigint IS NULL OR id<>$3)
       UNION ALL
       SELECT base_document,-1 FROM tuvansa.orders WHERE base_document IS NOT NULL AND ($3::bigint IS NULL OR id<>$3)
     )
     SELECT lines."productId",w.warehouse,sum(greatest(lines.assigned,0)*d.sign) AS assigned
     FROM documents d
     CROSS JOIN LATERAL (SELECT CASE WHEN trim(d.data->>'warehouse')='1' THEN '01' ELSE trim(d.data->>'warehouse') END AS warehouse) w
     CROSS JOIN LATERAL jsonb_to_recordset(d.data->'lines') AS lines("productId" bigint,assigned numeric)
     WHERE d.data->>'documentKind'='order' AND lines."productId"=ANY($1::bigint[])
       AND ($2::text IS NULL OR w.warehouse=$2)
     GROUP BY lines."productId",w.warehouse`,
    [products, warehouse, excludeOrderId],
  );
  return rows.map(({ productId, warehouse: code, assigned }) => ({ productId: Number(productId), warehouse: code, assigned: Number(assigned) }));
}

async function physicalStockDeltas(client: PostgresClient, products: number[], warehouse: string | null, tables: Awaited<ReturnType<typeof hasLocalSalesStock>>) {
  const names = [
    ...(tables.receipts ? ['purchase_reception_inventory'] : []),
    ...(tables.remissions ? ['sales_remission_inventory'] : []),
    ...(tables.receiptCancellations ? ['purchase_reception_cancellation_inventory'] : []),
    ...(tables.remissionCancellations ? ['sales_remission_cancellation_inventory'] : []),
    ...(tables.adjustments ? ['inventory_adjustment_stock'] : []),
  ];
  if (!names.length) return new Map<number, number>();
  const { rows } = await client.query<{ productId: string; quantity: string }>(
    `SELECT product_id AS "productId",sum(quantity) AS quantity FROM (
       ${names.map((table) => `SELECT product_id,quantity FROM tuvansa.${table} WHERE product_id=ANY($1::bigint[]) AND ($2::varchar IS NULL OR warehouse=$2)`).join(' UNION ALL ')}
     ) AS stock GROUP BY product_id`,
    [products, warehouse],
  );
  return new Map(rows.map(({ productId, quantity }) => [Number(productId), Number(quantity)]));
}

export async function localPhysicalStock(client: PostgresClient, products: number[]) {
  return physicalStockDeltas(client, products, null, await hasLocalSalesStock(client));
}

export async function readLocalWarehouseStock(warehouse: string, products: number[]) {
  const result = new Map<number, { quantity: number; assigned: number }>();
  if (!products.length || !postgresConfigured()) return result;
  const client = await connectPostgres();
  try {
    const tables = await hasLocalSalesStock(client);
    const physical = await physicalStockDeltas(client, products, warehouse, tables);
    const assigned = tables.orders ? await localOrderAssignmentRows(client, products, warehouse) : [];
    for (const [id, quantity] of physical) result.set(id, { quantity, assigned: 0 });
    for (const { productId, assigned: quantity } of assigned) {
      result.set(productId, { quantity: physical.get(productId) ?? 0, assigned: quantity });
    }
    return result;
  } finally {
    client.release();
  }
}

export async function assertSaleStock(client: PostgresClient, order: OrderProps, requests: SaleStockRequest[], lock = true) {
  if (!requests.length) return;
  const warehouse = normalizeOrderWarehouse(order.warehouse);
  return assertWarehouseStock(client, warehouse, requests, (productId) => {
    const product = order.lines.find((line) => line.productId === productId);
    return new ConflictError(`Existencia disponible insuficiente para ${product?.productCode ?? productId} en el almacén ${warehouse}.`, 'SALE_STOCK_INSUFFICIENT');
  }, order.id, lock);
}

export async function lockWarehouseStock(client: PostgresClient, warehouse: string, productIds: number[]) {
  // Assignments, dispatch and cancellations acquire the same locks in product ID order.
  for (const productId of [...new Set(productIds)].sort((a, b) => a - b)) {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('sales-stock:' || $1 || ':' || $2,0))", [warehouse, String(productId)]);
  }
}

export async function assertWarehouseStock(
  client: PostgresClient, warehouse: string, requests: SaleStockRequest[], unavailable: (productId: number) => ConflictError,
  excludeOrderId: number | null = null, lock = true,
) {
  if (!requests.length) return;
  const productIds = requests.map(({ productId }) => productId);
  if (lock) await lockWarehouseStock(client, warehouse, productIds);
  const tables = await hasLocalSalesStock(client);
  const assigned = new Map((tables.orders ? await localOrderAssignmentRows(client, productIds, warehouse, excludeOrderId) : [])
    .map(({ productId, assigned }) => [productId, assigned]));
  const physical = await physicalStockDeltas(client, productIds, warehouse, tables);
  for (const { productId, quantity, legacyOnHand, legacyAssigned } of requests) {
    const pending = Math.max(legacyAssigned + (assigned.get(productId) ?? 0), 0);
    const available = scaledStock(legacyOnHand + (physical.get(productId) ?? 0) - pending);
    if (quantity > available) throw unavailable(productId);
  }
}

export async function verifyLocalOrderAssignment(
  client: PostgresClient, previous: OrderProps, next: OrderProps, loadStock = readLegacySaleStock,
) {
  // Native order capture stores allocation in the base unit. For other units preserve the draft until its factor is available.
  const before = new Map<number, number>();
  const after = new Map<number, number>();
  for (const line of previous.lines) before.set(line.productId, (before.get(line.productId) ?? 0) + Math.max(0, line.assigned));
  for (const line of next.lines) after.set(line.productId, (after.get(line.productId) ?? 0) + Math.max(0, line.assigned));
  const productIds = [...after].filter(([productId, assigned]) => scaledStock(assigned - (before.get(productId) ?? 0)) > 0)
    .map(([productId]) => productId);
  if (!productIds.length) return;
  const warehouse = normalizeOrderWarehouse(next.warehouse);
  const rows = await loadStock(warehouse, productIds);
  await lockWarehouseStock(client, warehouse, productIds);
  const catalog = await catalogProductsById(productIds, client);
  const requests = productIds.map((productId) => {
    const reference = catalog.get(productId);
    if (reference?.deleted || reference?.document.isActive === false) {
      throw new ConflictError(`El producto ${reference.document.code} está dado de baja.`, 'PRODUCT_NOT_ACTIVE');
    }
    const legacy = rows.get(productId);
    const unit = ((reference?.revision || !legacy ? reference?.document.classification.unit.code : undefined) ?? legacy?.unit)?.trim();
    const valid = unit && next.lines.filter((line) => line.productId === productId && line.assigned > 0)
      .every((line) => line.unit.trim() === unit);
    if (!valid) throw new ConflictError('La asignación requiere una partida en la unidad base de inventario.', 'SALE_STOCK_UNIT_REQUIRED');
    return { productId, quantity: scaledStock(after.get(productId) ?? 0), legacyOnHand: Number(legacy?.onHand ?? 0), legacyAssigned: Number(legacy?.assigned ?? 0) };
  });
  await assertSaleStock(client, next, requests, false);
}
