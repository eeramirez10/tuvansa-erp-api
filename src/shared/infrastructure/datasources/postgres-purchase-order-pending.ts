import type { RowDataPacket } from 'mysql2/promise';
import { ApplicationError } from '../../domain/errors/application-error.js';
import { legacyMysqlPool } from '../database/legacy-mysql-pool.js';
import { connectPostgres, postgresConfigured, type PostgresClient } from '../database/postgres-pool.js';
import { readPurchaseOrderRemovals } from './postgres-purchase-order-removals.js';
import { readPurchaseOrderConfirmedStock } from './postgres-purchase-order-confirmation.js';

type OrderRef = { id: number; number: string };

async function legacyOrderQuantity(productId: number, orders: OrderRef[], quantity: 'pending' | 'confirmed'): Promise<number> {
  if (orders.length === 0) return 0;
  const pairs = orders.map(() => '(?, ?)').join(', ');
  const measure = quantity === 'pending' ? 'GREATEST(FPLIN.PLCANT-FPLIN.PLSURT, 0)' : 'FPLIN.PLASIGNADO';
  const [rows] = await legacyMysqlPool.execute<Array<RowDataPacket & { pending: string | number }>>(
    `SELECT COALESCE(SUM(${measure}), 0) AS pending
     FROM FPLIN JOIN FPENC ON FPENC.PESEQ=FPLIN.PESEQ
     WHERE FPLIN.ISEQ=? AND FPENC.PESPEDIDO=2 AND (FPENC.PESEQ, FPENC.PENUM) IN (${pairs})`,
    [productId, ...orders.flatMap(({ id, number }) => [id, number])],
  );
  return Number(rows[0]?.pending ?? 0);
}

export async function purchaseOrderInventoryAdjustment(productId: number): Promise<{ pending: number; confirmed: number }> {
  const empty = { pending: 0, confirmed: 0 };
  if (!postgresConfigured()) return empty;
  let client: PostgresClient | undefined;
  try {
    client = await connectPostgres();
    const result = await client.query<{ available: boolean }>(
      "SELECT to_regclass('tuvansa.purchase_order_stock_deltas') IS NOT NULL AS available",
    );
    if (!result.rows[0]?.available) return empty;
    // Read both sides of the PostgreSQL overlay from the same snapshot as a concurrent removal.
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const removed = (await readPurchaseOrderRemovals(client)).filter(({ legacy }) => legacy);
    const confirmed = await readPurchaseOrderConfirmedStock(client, productId);
    const { rows } = await client.query<{ pending: string }>(
      `SELECT COALESCE(SUM(pending),0) AS pending FROM tuvansa.purchase_order_stock_deltas AS stock
       WHERE product_id=$1${removed.length === 0 ? '' : ` AND NOT EXISTS (
         SELECT 1 FROM tuvansa.purchase_order_removals AS removed
         WHERE removed.legacy AND removed.order_id=stock.order_id AND removed.order_number=stock.order_number
       )`}`, [productId],
    );
    await client.query('COMMIT');
    client.release();
    client = undefined;
    // Reconcile the current source for orders whose balances have been overridden locally.
    const [legacyPending, legacyConfirmed] = await Promise.all([
      legacyOrderQuantity(productId, removed, 'pending'),
      legacyOrderQuantity(productId, confirmed.filter(({ legacy }) => legacy), 'confirmed'),
    ]);
    return {
      pending: Number(rows[0]?.pending ?? 0) - legacyPending,
      confirmed: confirmed.reduce((total, row) => total + row.assigned, 0) - legacyConfirmed,
    };
  } catch {
    if (client) await client.query('ROLLBACK').catch(() => undefined);
    throw new ApplicationError('No fue posible consultar los acumulados de compra.', 'PURCHASE_ORDER_POSTGRES_UNAVAILABLE', 503);
  } finally {
    client?.release();
  }
}
