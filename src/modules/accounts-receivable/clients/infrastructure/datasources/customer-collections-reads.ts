import type { PostgresClient } from '../../../../../shared/infrastructure/database/postgres-pool.js';
import {
  historicalSalesRemissionCancellationsOn, remissionCancellationSql, salesRemissionCancellationsAvailable,
} from '../../../../sales/invoicing/infrastructure/datasources/sales-remission-cancellation-reads.js';
import { customerCollectionReversalSql, customerCollectionReversalsAvailable } from './customer-collection-reversal-reads.js';

export async function customerCollectionsAvailable(client: PostgresClient): Promise<boolean> {
  const { rows: [row] } = await client.query<{ available: boolean }>(
    "SELECT to_regclass('tuvansa.customer_collections') IS NOT NULL AS available",
  );
  return row?.available === true;
}

export function joinRemissionCollections(available: boolean, withReversals: boolean): string {
  if (!available) {
    return 'CROSS JOIN (SELECT 0::numeric AS paid, NULL::date AS last_payment_date) AS collections';
  }
  const reversal = customerCollectionReversalSql(withReversals);
  // Derivada. El documento, cliente y empresa deben coincidir para aplicar el cobro.
  return `LEFT JOIN LATERAL (
    SELECT coalesce(${reversal.paid}, 0) AS paid,
           max(collection.date) FILTER (WHERE ${reversal.active}) AS last_payment_date
    FROM tuvansa.customer_collections AS collection ${reversal.join}
    WHERE collection.remission_id = remission.id AND collection.client_id = remission.customer_id
      AND collection.company_id = remission.company_id
  ) AS collections ON true`;
}

export async function remissionCollectionStatus(client: PostgresClient, { id, customerId, companyId }: { id: number; customerId: number; companyId: number }) {
  if (!await customerCollectionsAvailable(client)) return { hasCollection: false, lastCollectionReversalAt: null };
  const reversal = customerCollectionReversalSql(await customerCollectionReversalsAvailable(client));
  const { rows: [row] } = await client.query<{ hasCollection: boolean; lastCollectionReversalAt: string | null }>(
    `SELECT count(*) FILTER (WHERE ${reversal.active})>0 AS "hasCollection",${reversal.latestDate} AS "lastCollectionReversalAt"
     FROM tuvansa.customer_collections collection ${reversal.join} WHERE collection.remission_id=$1 AND collection.client_id=$2
       AND collection.company_id=$3 AND collection.amount>0`, [id, customerId, companyId],
  );
  return row!;
}

export async function salesRemissionsOutstanding(client: PostgresClient, companyId: number, customerId: number): Promise<number> {
  const join = joinRemissionCollections(await customerCollectionsAvailable(client), await customerCollectionReversalsAvailable(client));
  const hasCancellations = await salesRemissionCancellationsAvailable(client);
  const cancellation = remissionCancellationSql(hasCancellations);
  const { rows: [row] } = await client.query<{ amount: number }>(
    `SELECT coalesce(sum(remission.charge - collections.paid), 0)::float8 AS amount
     FROM tuvansa.sales_remissions AS remission ${join} ${cancellation.join}
     WHERE remission.company_id = $1 AND remission.customer_id = $2 AND NOT (${cancellation.canceled})`, [companyId, customerId],
  );
  const historical = hasCancellations && companyId === 1
    ? await historicalSalesRemissionCancellationsOn(client, { customerIds: [customerId] }) : [];
  return historical.reduce((balance, { amount }) => balance - amount, row?.amount ?? 0);
}
