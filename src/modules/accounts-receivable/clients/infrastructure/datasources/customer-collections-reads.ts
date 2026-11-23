import type { PostgresClient } from '../../../../../shared/infrastructure/database/postgres-pool.js';

export async function customerCollectionsAvailable(client: PostgresClient): Promise<boolean> {
  const { rows: [row] } = await client.query<{ available: boolean }>(
    "SELECT to_regclass('tuvansa.customer_collections') IS NOT NULL AS available",
  );
  return row?.available === true;
}

export function joinRemissionCollections(available: boolean): string {
  if (!available) {
    return 'CROSS JOIN (SELECT 0::numeric AS paid, NULL::date AS last_payment_date) AS collections';
  }
  // Derivada. El documento, cliente y empresa deben coincidir para aplicar el cobro.
  return `LEFT JOIN LATERAL (
    SELECT coalesce(sum(collection.amount), 0) AS paid,
           max(collection.date) AS last_payment_date
    FROM tuvansa.customer_collections AS collection
    WHERE collection.remission_id = remission.id AND collection.client_id = remission.customer_id
      AND collection.company_id = remission.company_id
  ) AS collections ON true`;
}

export async function salesRemissionsOutstanding(client: PostgresClient, companyId: number, customerId: number): Promise<number> {
  const join = joinRemissionCollections(await customerCollectionsAvailable(client));
  const { rows: [row] } = await client.query<{ amount: number }>(
    `SELECT coalesce(sum(remission.charge - collections.paid), 0)::float8 AS amount
     FROM tuvansa.sales_remissions AS remission ${join}
     WHERE remission.company_id = $1 AND remission.customer_id = $2`, [companyId, customerId],
  );
  return row?.amount ?? 0;
}
