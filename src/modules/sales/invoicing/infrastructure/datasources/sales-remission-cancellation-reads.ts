import type { PostgresClient } from '../../../../../shared/infrastructure/database/postgres-pool.js';

export const salesRemissionCancellationIdStart = 7960000000000;
export const salesRemissionCancellationIdEnd = salesRemissionCancellationIdStart + 99999998;
export const isLocalSalesRemissionCancellationId = (id: number) => id >= salesRemissionCancellationIdStart && id <= salesRemissionCancellationIdEnd;

export async function salesRemissionCancellationsAvailable(client: PostgresClient) {
  const { rows: [row] } = await client.query<{ available: boolean }>(
    "SELECT to_regclass('tuvansa.sales_remission_cancellations') IS NOT NULL AS available",
  );
  return row?.available ?? false;
}

export function remissionCancellationSql(available: boolean, original = 'remission') {
  return {
    join: available ? `LEFT JOIN tuvansa.sales_remission_cancellations cancellation
      ON cancellation.remission_id=${original}.id AND cancellation.company_id=${original}.company_id` : '',
    canceled: available ? 'cancellation.id IS NOT NULL' : 'false',
    result: available ? 'cancellation.result' : 'null::jsonb',
  };
}
