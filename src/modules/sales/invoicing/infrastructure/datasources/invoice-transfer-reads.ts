import { connectPostgres, postgresConfigured, type PostgresClient } from '../../../../../shared/infrastructure/database/postgres-pool.js';
import type { InvoiceTransferReceipt } from '../../domain/entities/invoice-transfer.js';

export interface InvoiceTransferPosting {
  invoiceId: number;
  customerId: number;
  number: string;
  orderNumber: string;
  issuedAt: string;
  dueAt: string | null;
  amount: number;
  userId: number;
  result: InvoiceTransferReceipt;
}

type Filter = { invoiceIds: number[] } | { customerIds: number[] };

export async function lockInvoiceTransfer(client: PostgresClient, invoiceId: number) {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('sales-invoice-transfer:'||$1::text,0))", [invoiceId]);
}

export async function invoiceTransfersOn(client: PostgresClient, filter: Filter) {
  const ids = 'invoiceIds' in filter ? filter.invoiceIds : filter.customerIds;
  if (!ids.length) return [];
  const { rows: [table] } = await client.query<{ available: boolean }>(
    "SELECT to_regclass('tuvansa.invoice_transfers') IS NOT NULL AS available",
  );
  if (!table?.available) return [];
  const field = 'invoiceIds' in filter ? 'invoice_id' : 'customer_id';
  const { rows } = await client.query<InvoiceTransferPosting>(
    `SELECT invoice_id::float8 AS "invoiceId",customer_id::float8 AS "customerId",source_number AS number,
       order_number AS "orderNumber",issued_at::text AS "issuedAt",due_at::text AS "dueAt",amount::float8 AS amount,
       user_id AS "userId",result
     FROM tuvansa.invoice_transfers WHERE ${field}=ANY($1::bigint[]) ORDER BY id`, [ids],
  );
  return rows;
}

export async function readInvoiceTransfers(filter: Filter) {
  if (!postgresConfigured()) return [];
  const client = await connectPostgres();
  try { return await invoiceTransfersOn(client, filter); }
  finally { client.release(); }
}
