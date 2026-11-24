import type { PostgresClient } from '../../../../../shared/infrastructure/database/postgres-pool.js';
import type { SalesRemissionCancellationResult } from '../../domain/datasources/sales-remission-cancellation-data-source.js';

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

export interface HistoricalSalesRemissionCancellation {
  invoiceId: number;
  customerId: number;
  number: string;
  orderNumber: string;
  amount: number;
  issuedAt: string;
  dueAt: string | null;
  userId: number;
  result: SalesRemissionCancellationResult;
}

export type HistoricalSalesRemissionFilter = { invoiceIds: number[] } | { customerIds: number[] };

export async function historicalSalesRemissionCancellationsOn(client: PostgresClient, filter: HistoricalSalesRemissionFilter) {
  const byInvoice = 'invoiceIds' in filter;
  const ids = byInvoice ? filter.invoiceIds : filter.customerIds;
  if (!ids.length) return [];
  const { rows: [schema] } = await client.query<{ available: boolean }>(
    `SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='tuvansa'
      AND table_name='sales_remission_cancellations' AND column_name='legacy_invoice_id') AS available`,
  );
  if (!schema?.available) return [];
  const field = byInvoice ? 'legacy_invoice_id' : "(historical_source->>'customerId')::bigint";
  const { rows } = await client.query<HistoricalSalesRemissionCancellation>(
    `SELECT legacy_invoice_id::float8 AS "invoiceId",(historical_source->>'customerId')::float8 AS "customerId",
       historical_source->>'number' AS number,historical_source->>'orderNumber' AS "orderNumber",
       (historical_source->>'amount')::float8 AS amount,historical_source->>'issuedAt' AS "issuedAt",
       historical_source->>'dueAt' AS "dueAt",user_id AS "userId",result
     FROM tuvansa.sales_remission_cancellations WHERE company_id=1 AND legacy_invoice_id IS NOT NULL
       AND ${field}=ANY($1::bigint[]) ORDER BY date,id`,
    [ids],
  );
  return rows;
}
