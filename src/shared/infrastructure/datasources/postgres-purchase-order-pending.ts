import { ApplicationError } from '../../domain/errors/application-error.js';
import { connectPostgres, postgresConfigured, type PostgresClient } from '../database/postgres-pool.js';

export async function purchaseOrderPendingAdjustment(productId: number): Promise<number> {
  if (!postgresConfigured()) return 0;
  let client: PostgresClient | undefined;
  try {
    client = await connectPostgres();
    const result = await client.query<{ available: boolean }>(
      "SELECT to_regclass('tuvansa.purchase_order_stock_deltas') IS NOT NULL AS available",
    );
    if (!result.rows[0]?.available) return 0;
    const { rows } = await client.query<{ pending: string }>(
      'SELECT COALESCE(SUM(pending),0) AS pending FROM tuvansa.purchase_order_stock_deltas WHERE product_id=$1',
      [productId],
    );
    return Number(rows[0]?.pending ?? 0);
  } catch {
    throw new ApplicationError('No fue posible consultar los pendientes de compra en PostgreSQL.', 'PURCHASE_ORDER_POSTGRES_UNAVAILABLE', 503);
  } finally {
    client?.release();
  }
}
