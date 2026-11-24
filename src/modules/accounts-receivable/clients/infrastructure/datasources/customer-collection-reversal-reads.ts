import type { PostgresClient } from '../../../../../shared/infrastructure/database/postgres-pool.js';
import { reversalReferenceSql } from '../../../../purchasing/purchase-receptions/infrastructure/datasources/purchase-posting-reversal-reads.js';

export const customerCollectionReversalIdStart = 7980000000000;
export const customerCollectionReversalIdEnd = customerCollectionReversalIdStart + 99999998;
export const isLocalCustomerCollectionReversalId = (id: number) => id >= customerCollectionReversalIdStart && id <= customerCollectionReversalIdEnd;

export async function customerCollectionReversalsAvailable(client: PostgresClient) {
  const { rows: [row] } = await client.query<{ available: boolean }>(
    "SELECT to_regclass('tuvansa.customer_collection_reversals') IS NOT NULL AS available",
  );
  return row?.available ?? false;
}

export function customerCollectionReversalSql(available: boolean, original = 'collection') {
  return {
    join: available ? `LEFT JOIN tuvansa.customer_collection_reversals reversal
      ON reversal.collection_id=${original}.id AND reversal.company_id=${original}.company_id` : '',
    active: available ? 'reversal.id IS NULL' : 'true',
    paid: `sum(${original}.amount)${available ? ' FILTER (WHERE reversal.id IS NULL)' : ''}`,
    revision: available ? '(count(*) + count(reversal.id) + 1)::integer' : '(count(*) + 1)::integer',
    latestDate: available ? 'max(reversal.date)::text' : 'null::text',
    reference: available ? `(${reversalReferenceSql('reversal')}) ||
      jsonb_strip_nulls(jsonb_build_object('originalReconciliation',reversal.result->'originalReconciliation'))` : 'null::jsonb',
    result: available ? 'reversal.result' : 'null::jsonb',
  };
}
