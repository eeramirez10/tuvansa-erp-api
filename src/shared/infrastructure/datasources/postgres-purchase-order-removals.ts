import { ApplicationError } from '../../domain/errors/application-error.js';
import { NotFoundError } from '../../domain/errors/not-found-error.js';
import { connectPostgres, postgresConfigured, type PostgresClient } from '../database/postgres-pool.js';

type OrderRef = { id: number; number: string };
type RemovedOrder = OrderRef & { legacy: boolean };

export async function readPurchaseOrderRemovals(client: PostgresClient, ids?: number[]): Promise<RemovedOrder[]> {
  const { rows: [table] } = await client.query<{ available: boolean }>(
    "SELECT to_regclass('tuvansa.purchase_order_removals') IS NOT NULL AS available",
  );
  if (!table?.available) return [];
  const { rows } = await client.query<{ id: string; number: string; legacy: boolean }>(
    `SELECT order_id AS id, order_number AS number, legacy FROM tuvansa.purchase_order_removals
     ${ids ? 'WHERE order_id = ANY($1::bigint[])' : ''}`, ids ? [ids] : [],
  );
  return rows.map(({ id, ...order }) => ({ id: Number(id), ...order }));
}

export async function legacyPurchaseOrderRemovals(): Promise<OrderRef[]> {
  if (!postgresConfigured()) return [];
  let client: PostgresClient | undefined;
  try {
    client = await connectPostgres();
    return (await readPurchaseOrderRemovals(client)).filter(({ legacy }) => legacy);
  } catch {
    throw new ApplicationError('No fue posible consultar las bajas de órdenes de compra.', 'PURCHASE_ORDER_POSTGRES_UNAVAILABLE', 503);
  } finally {
    client?.release();
  }
}

export async function lockPurchaseOrderWrite(client: PostgresClient, id: number): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('purchase-order:' || $1::text, 0))", [id]);
}

export async function assertActivePurchaseOrder(client: PostgresClient, order: OrderRef): Promise<void> {
  const removed = (await readPurchaseOrderRemovals(client, [order.id])).some(({ number }) => number === order.number);
  if (removed) throw new NotFoundError('Orden de compra');
}

export function excludeRemovedPurchaseOrders(removed: OrderRef[], table: 'FPENC' | 'fpenc') {
  if (removed.length === 0) return { sql: '', parameters: [] };
  const pairs = removed.map(() => '(?, ?)').join(', ');
  return {
    sql: ` AND (${table}.PESEQ, ${table}.PENUM) NOT IN (${pairs})`,
    parameters: removed.flatMap(({ id, number }) => [id, number]),
  };
}
