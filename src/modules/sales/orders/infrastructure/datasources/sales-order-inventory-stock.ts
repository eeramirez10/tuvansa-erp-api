import type { RowDataPacket } from 'mysql2/promise';
import { ConflictError } from '../../../../../shared/domain/errors/conflict-error.js';
import { legacyMysqlPool } from '../../../../../shared/infrastructure/database/legacy-mysql-pool.js';
import type { PostgresClient } from '../../../../../shared/infrastructure/database/postgres-pool.js';
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
  const { rows: [tables] } = await client.query<{ orders: boolean; receipts: boolean; remissions: boolean }>(
    `SELECT to_regclass('tuvansa.orders') IS NOT NULL AS orders,
            to_regclass('tuvansa.purchase_reception_inventory') IS NOT NULL AS receipts,
            to_regclass('tuvansa.sales_remission_inventory') IS NOT NULL AS remissions`,
  );
  return tables ?? { orders: false, receipts: false, remissions: false };
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

async function warehouseDeltas(client: PostgresClient, products: number[], warehouse: string) {
  const tables = await hasLocalSalesStock(client);
  const names = [
    ...(tables.receipts ? ['purchase_reception_inventory'] : []),
    ...(tables.remissions ? ['sales_remission_inventory'] : []),
  ];
  if (!names.length) return new Map<number, number>();
  const { rows } = await client.query<{ productId: string; quantity: string }>(
    `SELECT product_id AS "productId",sum(quantity) AS quantity FROM (
       ${names.map((table) => `SELECT product_id,quantity FROM tuvansa.${table} WHERE product_id=ANY($1::bigint[]) AND warehouse=$2`).join(' UNION ALL ')}
     ) AS stock GROUP BY product_id`,
    [products, warehouse],
  );
  return new Map(rows.map(({ productId, quantity }) => [Number(productId), Number(quantity)]));
}

export async function assertSaleStock(client: PostgresClient, order: OrderProps, requests: SaleStockRequest[]) {
  if (!requests.length) return;
  const warehouse = normalizeOrderWarehouse(order.warehouse);
  const productIds = requests.map(({ productId }) => productId).sort((a, b) => a - b);
  // Both assignments and dispatch lock inventory in product ID order.
  for (const productId of productIds) {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('sales-stock:' || $1 || ':' || $2,0))", [warehouse, String(productId)]);
  }
  const assigned = new Map((await localOrderAssignmentRows(client, productIds, warehouse, order.id))
    .map(({ productId, assigned }) => [productId, assigned]));
  const physical = await warehouseDeltas(client, productIds, warehouse);
  for (const { productId, quantity, legacyOnHand, legacyAssigned } of requests) {
    const pending = Math.max(legacyAssigned + (assigned.get(productId) ?? 0), 0);
    const available = scaledStock(legacyOnHand + (physical.get(productId) ?? 0) - pending);
    if (quantity > available) {
      const product = order.lines.find((line) => line.productId === productId);
      throw new ConflictError(`Existencia disponible insuficiente para ${product?.productCode ?? productId} en el almacén ${warehouse}.`, 'SALE_STOCK_INSUFFICIENT');
    }
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
  const rows = await loadStock(normalizeOrderWarehouse(next.warehouse), productIds);
  const requests = productIds.map((productId) => {
    const stock = rows.get(productId);
    const valid = stock && next.lines.filter((line) => line.productId === productId && line.assigned > 0)
      .every((line) => line.unit.trim() === stock.unit.trim());
    if (!valid || !stock) throw new ConflictError('La asignación requiere una partida en la unidad base de inventario.', 'SALE_STOCK_UNIT_REQUIRED');
    return { productId, quantity: scaledStock(after.get(productId) ?? 0), legacyOnHand: Number(stock.onHand), legacyAssigned: Number(stock.assigned) };
  });
  await assertSaleStock(client, next, requests);
}
