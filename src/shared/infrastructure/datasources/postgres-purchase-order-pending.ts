import type { RowDataPacket } from 'mysql2/promise';
import { ApplicationError } from '../../domain/errors/application-error.js';
import { legacyMysqlPool } from '../database/legacy-mysql-pool.js';
import { connectPostgres, postgresConfigured, type PostgresClient } from '../database/postgres-pool.js';
import { readPurchaseOrderRemovals } from './postgres-purchase-order-removals.js';

async function legacyRemovedPending(productId: number, removed: Array<{ id: number; number: string }>): Promise<number> {
  if (removed.length === 0) return 0;
  const pairs = removed.map(() => '(?, ?)').join(', ');
  const [rows] = await legacyMysqlPool.execute<Array<RowDataPacket & { pending: string | number }>>(
    `SELECT COALESCE(SUM(GREATEST(FPLIN.PLCANT-FPLIN.PLSURT, 0)), 0) AS pending
     FROM FPLIN JOIN FPENC ON FPENC.PESEQ=FPLIN.PESEQ
     WHERE FPLIN.ISEQ=? AND FPENC.PESPEDIDO=2 AND (FPENC.PESEQ, FPENC.PENUM) IN (${pairs})`,
    [productId, ...removed.flatMap(({ id, number }) => [id, number])],
  );
  return Number(rows[0]?.pending ?? 0);
}

export async function purchaseOrderPendingAdjustment(productId: number): Promise<number> {
  if (!postgresConfigured()) return 0;
  let client: PostgresClient | undefined;
  try {
    client = await connectPostgres();
    const result = await client.query<{ available: boolean }>(
      "SELECT to_regclass('tuvansa.purchase_order_stock_deltas') IS NOT NULL AS available",
    );
    if (!result.rows[0]?.available) return 0;
    // Read both sides of the PostgreSQL overlay from the same snapshot as a concurrent removal.
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const removed = (await readPurchaseOrderRemovals(client)).filter(({ legacy }) => legacy);
    const { rows } = await client.query<{ pending: string }>(
      `SELECT COALESCE(SUM(pending),0) AS pending FROM tuvansa.purchase_order_stock_deltas AS stock
       WHERE product_id=$1${removed.length === 0 ? '' : ` AND NOT EXISTS (
         SELECT 1 FROM tuvansa.purchase_order_removals AS removed
         WHERE removed.legacy AND removed.order_id=stock.order_id AND removed.order_number=stock.order_number
       )`}`, [productId],
    );
    await client.query('COMMIT');
    // A legacy reception or deletion can change the source aggregate after the web removal.
    return Number(rows[0]?.pending ?? 0) - await legacyRemovedPending(productId, removed);
  } catch {
    if (client) await client.query('ROLLBACK').catch(() => undefined);
    throw new ApplicationError('No fue posible consultar los pendientes de compra en PostgreSQL.', 'PURCHASE_ORDER_POSTGRES_UNAVAILABLE', 503);
  } finally {
    client?.release();
  }
}
