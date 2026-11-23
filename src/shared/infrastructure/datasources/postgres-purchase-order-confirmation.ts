import { ApplicationError } from '../../domain/errors/application-error.js';
import { connectPostgres, postgresConfigured, type PostgresClient } from '../database/postgres-pool.js';

type ConfirmedRow = { id: string; number: string; legacy: boolean; assigned: string };

async function confirmedStockAvailable(client: PostgresClient) {
  const { rows: [row] } = await client.query<{ available: boolean }>(
    "SELECT to_regclass('tuvansa.purchase_order_confirmed_stock') IS NOT NULL AS available",
  );
  return row?.available ?? false;
}

export async function readPurchaseOrderConfirmedStock(client: PostgresClient, productId: number) {
  if (!await confirmedStockAvailable(client)) return [];
  const { rows } = await client.query<ConfirmedRow>(
    `SELECT order_id AS id, order_number AS number, legacy, assigned FROM tuvansa.purchase_order_confirmed_stock WHERE product_id=$1`,
    [productId],
  );
  return rows.map(({ id, assigned, ...row }) => ({ ...row, id: Number(id), assigned: Number(assigned) }));
}

export async function purchaseOrderLineAssignments(productId: number, lines: number[]) {
  if (!postgresConfigured() || lines.length === 0) return [];
  let client: PostgresClient | undefined;
  try {
    client = await connectPostgres();
    if (!await confirmedStockAvailable(client)) return [];
    const { rows } = await client.query<{ id: string | null; orderId: string; number: string; assigned: string | null }>(
      `SELECT line.id, stock.order_id AS "orderId", snapshot.order_number AS number, line.assigned
       FROM tuvansa.purchase_order_confirmed_stock AS stock
       JOIN tuvansa.purchase_order_edits AS snapshot
         ON (snapshot.order_id, snapshot.order_number)=(stock.order_id, stock.order_number)
       LEFT JOIN LATERAL (
         SELECT item->>'id' AS id, item->>'assigned' AS assigned
         FROM jsonb_array_elements(snapshot.document->'lines') AS item
         WHERE (item->>'productId')::bigint=$1 AND (item->>'id')::bigint=ANY($2::bigint[])
       ) AS line ON true
       WHERE stock.legacy AND stock.product_id=$1`, [productId, lines],
    );
    return rows.map(({ id, orderId, number, assigned }) => ({ id: id === null ? null : Number(id), orderId: Number(orderId), number, assigned: Number(assigned) }));
  } catch {
    throw new ApplicationError('No fue posible consultar las partidas confirmadas en PostgreSQL.', 'PURCHASE_ORDER_POSTGRES_UNAVAILABLE', 503);
  } finally {
    client?.release();
  }
}
