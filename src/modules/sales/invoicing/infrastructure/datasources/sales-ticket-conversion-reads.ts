import type { PostgresClient } from '../../../../../shared/infrastructure/database/postgres-pool.js';

export async function salesTicketConversionSql(client: PostgresClient, source = 'remission') {
  const { rows: [table] } = await client.query<{ available: boolean }>(
    "SELECT to_regclass('tuvansa.sales_ticket_conversions') IS NOT NULL AS available",
  );
  const originalInvoice = `(${source}.result->'invoice')`;
  return table?.available ? {
    join: `LEFT JOIN tuvansa.sales_ticket_conversions ticket_conversion ON ticket_conversion.remission_id=${source}.id`,
    number: `coalesce(ticket_conversion.number,${source}.number)`,
    issuedAt: `coalesce(ticket_conversion.issued_at,${source}.issued_at)`,
    invoice: `coalesce(ticket_conversion.invoice,${originalInvoice})`,
    converted: 'ticket_conversion.remission_id IS NOT NULL',
    result: 'ticket_conversion.result',
  } : {
    join: '', number: `${source}.number`, issuedAt: `${source}.issued_at`, invoice: originalInvoice,
    converted: 'false', result: 'null::jsonb',
  };
}
