import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import { connectPostgres, postgresConfigured, type PostgresClient } from '../../../../../shared/infrastructure/database/postgres-pool.js';
import { reversalReferenceSql } from './purchase-posting-reversal-reads.js';

// La columna nueva es opcional en respaldos que sólo registraron pagos de recepciones.
export const paymentDocumentIdSql = (alias: string) => `coalesce(${alias}.receipt_id,
  (to_jsonb(${alias})->>'expense_id')::bigint,(to_jsonb(${alias})->>'documentation_document_id')::bigint)`;

export interface PurchaseDocumentTables {
  receipts: boolean;
  expenses: boolean;
  expenseCancellations: boolean;
  receiptCancellations: boolean;
  documentations: boolean;
  supplierChanges: boolean;
}

export async function purchaseDocumentTables(client: PostgresClient): Promise<PurchaseDocumentTables> {
  const { rows: [tables] } = await client.query<PurchaseDocumentTables>(
    `SELECT to_regclass('tuvansa.purchase_receptions') IS NOT NULL AS receipts,
            to_regclass('tuvansa.purchase_expense_documents') IS NOT NULL AS expenses,
            to_regclass('tuvansa.purchase_expense_cancellations') IS NOT NULL AS "expenseCancellations",
            to_regclass('tuvansa.purchase_reception_cancellations') IS NOT NULL AS "receiptCancellations",
            to_regclass('tuvansa.purchase_reception_documentations') IS NOT NULL AS documentations,
            to_regclass('tuvansa.purchase_reception_supplier_changes') IS NOT NULL AS "supplierChanges"`,
  );
  return tables ?? {
    receipts: false, expenses: false, expenseCancellations: false, receiptCancellations: false, documentations: false, supplierChanges: false,
  };
}

export function receiptCancellationSql(available: boolean) {
  return {
    cancelled: available ? 'cancellation.id IS NOT NULL' : 'false',
    reference: available ? reversalReferenceSql('cancellation') : 'null::jsonb',
    join: available ? `LEFT JOIN tuvansa.purchase_reception_cancellations cancellation
      ON cancellation.receipt_id=r.id AND cancellation.company_id=r.company_id` : '',
  };
}

export function expenseCancellationSql(available: boolean) {
  return {
    cancelled: available ? 'cancellation.id IS NOT NULL' : 'false',
    reference: available ? reversalReferenceSql('cancellation') : 'null::jsonb',
    join: available ? `LEFT JOIN tuvansa.purchase_expense_cancellations cancellation
      ON cancellation.batch_id=b.id AND cancellation.company_id=b.company_id` : '',
  };
}

export function receiptDocumentationSql(available: boolean) {
  return {
    amount: available ? 'coalesce(documentation.amount,0)' : '0',
    present: available ? 'documentation.id IS NOT NULL' : 'false',
    join: available ? `LEFT JOIN tuvansa.purchase_reception_documentations documentation
      ON documentation.local_receipt_id=r.id AND documentation.company_id=r.company_id` : '',
    reference: available ? `CASE WHEN documentation.id IS NOT NULL THEN
      jsonb_build_object('id',documentation.id,'sourceId',documentation.source_id,'amount',documentation.amount,'date',documentation.date,
        'userId',documentation.user_id,'createdAt',documentation.created_at::text) END` : 'null::jsonb',
  };
}

function payablesSql(tables: PurchaseDocumentTables): string | null {
  const sources: string[] = [];
  const receiptCancellation = receiptCancellationSql(tables.receiptCancellations);
  const documentation = receiptDocumentationSql(tables.documentations);
  const supplier = tables.supplierChanges ? {
    id: "coalesce(supplier_change.supplier_id,(r.result #>> '{reception,supplier,id}')::bigint)",
    code: "coalesce(supplier_change.supplier_code,r.result #>> '{reception,supplier,code}')",
    name: "coalesce(supplier_change.supplier_name,r.result #>> '{reception,supplier,name}')",
    account: 'supplier_change.supplier_account',
    join: `LEFT JOIN tuvansa.purchase_reception_supplier_changes supplier_change
      ON supplier_change.company_id=r.company_id AND supplier_change.receipt_id=r.id AND supplier_change.receipt_number=r.number
      AND supplier_change.original_supplier_id=(r.result #>> '{reception,supplier,id}')::bigint AND NOT supplier_change.historical`,
  } : {
    id: "(r.result #>> '{reception,supplier,id}')::bigint",
    code: "r.result #>> '{reception,supplier,code}'",
    name: "r.result #>> '{reception,supplier,name}'",
    account: 'null::text',
    join: '',
  };
  const localPayment = 'true AS can_pay,false AS historical_transfer_out,false AS historical_transfer_in,null::bigint AS source_movement_id';
  if (tables.receipts) sources.push(`
    SELECT r.id,r.company_id,r.number,
      ${supplier.id} AS supplier_id,${supplier.code} AS supplier_code,${supplier.name} AS supplier_name,
      nullif(r.result #>> '{reception,dates,receivedAt}','')::date AS received_at,
      nullif(r.payable->>'dueAt','')::date AS due_at,
      coalesce((r.payable->>'amount')::numeric,0) AS principal,
      coalesce((r.payable->>'currencyId')::integer,0) AS currency_id,
      coalesce((r.payable->>'exchangeRate')::numeric,0) AS exchange_rate,
      (${receiptCancellation.cancelled} OR coalesce((r.result #>> '{reception,cancelled}')::boolean,false)) AS cancelled,
      ${supplier.account} AS supplier_account,null::text AS supplier_account_name,
      r.result #>> '{reception,supplierReference}' AS supplier_reference,r.order_number,
      r.movement #>> '{header,type}' AS movement_type,r.user_id,r.accounting->>'number' AS policy_number,
      CASE WHEN r.accounting IS NOT NULL THEN r.id END AS policy_id,r.created_at,${receiptCancellation.reference} AS cancellation,
      ${documentation.amount} AS documented_amount,${documentation.reference} AS documentation,false AS historical_documentation,${localPayment}
    FROM tuvansa.purchase_receptions r ${receiptCancellation.join} ${documentation.join} ${supplier.join} WHERE r.number LIKE 'RW%'`);
  const cancellation = expenseCancellationSql(tables.expenseCancellations);
  if (tables.expenses) sources.push(`
    SELECT d.id,d.company_id,d.number,d.supplier_id,d.supplier_code,d.supplier_name,
      d.date AS received_at,d.due_date AS due_at,d.amount AS principal,
      1 AS currency_id,1::numeric AS exchange_rate,${cancellation.cancelled} AS cancelled,d.supplier_account,d.supplier_account_name,
      d.reference AS supplier_reference,''::text AS order_number,'GA'::text AS movement_type,b.user_id,
      b.policy_number,b.id AS policy_id,b.created_at,${cancellation.reference} AS cancellation,
      0 AS documented_amount,null::jsonb AS documentation,false AS historical_documentation,${localPayment}
    FROM tuvansa.purchase_expense_documents d
    JOIN tuvansa.purchase_expense_batches b ON b.id=d.batch_id AND b.company_id=d.company_id
    ${cancellation.join}`);
  if (tables.documentations) sources.push(`
    SELECT d.id,d.company_id,d.number,h.supplier_id,h.supplier_code,h.supplier_name,
      h.date AS received_at,h.due_date AS due_at,d.amount AS principal,
      1 AS currency_id,1::numeric AS exchange_rate,false AS cancelled,
      to_jsonb(h)->>'supplier_account' AS supplier_account,null::text AS supplier_account_name,
      h.source_number AS supplier_reference,''::text AS order_number,'DO'::text AS movement_type,h.user_id,
      null::text AS policy_number,null::bigint AS policy_id,h.created_at,null::jsonb AS cancellation,
      0 AS documented_amount,null::jsonb AS documentation,false AS historical_documentation,${localPayment}
    FROM tuvansa.purchase_reception_documentation_documents d
    JOIN tuvansa.purchase_reception_documentations h ON h.id=d.documentation_id AND h.company_id=d.company_id`);
  if (tables.documentations) sources.push(`
    SELECT documentation.id,documentation.company_id,documentation.source_number,documentation.supplier_id,
      documentation.supplier_code,documentation.supplier_name,documentation.date,documentation.due_date,0::numeric,
      1,1::numeric,false,null::text,null::text,''::text,''::text,'DO'::text,documentation.user_id,
      null::text,null::bigint,documentation.created_at,null::jsonb,documentation.amount,${documentation.reference},true,
      false,false,false,null::bigint
    FROM tuvansa.purchase_reception_documentations documentation WHERE documentation.local_receipt_id IS NULL
    ${tables.supplierChanges ? `AND NOT EXISTS (
      SELECT 1 FROM tuvansa.purchase_reception_supplier_changes s
      WHERE s.company_id=documentation.company_id AND s.receipt_id=documentation.source_id AND s.receipt_number=documentation.source_number
        AND s.historical AND s.supplier_id=documentation.supplier_id AND s.supplier_id<>s.original_supplier_id
    )` : ''}`);
  if (tables.supplierChanges) {
    const historicalCancellation = tables.receiptCancellations ? {
      cancelled: 'cancelled.id IS NOT NULL',
      reference: reversalReferenceSql('cancelled'),
      join: `LEFT JOIN tuvansa.purchase_reception_cancellations cancelled ON cancelled.company_id=s.company_id
        AND (to_jsonb(cancelled)->>'legacy_receipt_id')::bigint=s.receipt_id`,
    } : { cancelled: 'false', reference: 'null::jsonb', join: '' };
    const historicalDocumentation = tables.documentations ? `LEFT JOIN tuvansa.purchase_reception_documentations documentation
      ON documentation.company_id=s.company_id AND documentation.source_id=s.receipt_id AND documentation.source_number=s.receipt_number
      AND documentation.local_receipt_id IS NULL AND documentation.supplier_id=s.supplier_id` : '';
    const active = 's.historical AND s.supplier_id<>s.original_supplier_id';
    sources.push(`
      SELECT s.receipt_id,s.company_id,s.receipt_number,s.supplier_id,s.supplier_code,s.supplier_name,
        nullif(s.charge->>'date','')::date,nullif(s.charge->>'dueAt','')::date,s.amount,
        1,1::numeric,${historicalCancellation.cancelled},s.supplier_account,null::text,
        s.charge->>'supplierReference',s.charge->>'orderNumber','RA'::text,(s.charge->>'userId')::integer,
        s.charge->>'policyNumber',null::bigint,s.updated_at,${historicalCancellation.reference},
        ${documentation.amount},${documentation.reference},false,false,false,true,(s.charge->>'id')::bigint
      FROM tuvansa.purchase_reception_supplier_changes s ${historicalCancellation.join} ${historicalDocumentation}
      WHERE ${active}
      UNION ALL
      SELECT s.receipt_id,s.company_id,s.receipt_number,s.original_supplier_id,''::text,''::text,
        null::date,null::date,-s.amount,1,1::numeric,false,null::text,null::text,''::text,''::text,
        'RA'::text,0,null::text,null::bigint,s.updated_at,null::jsonb,0,null::jsonb,false,false,true,false,null::bigint
      FROM tuvansa.purchase_reception_supplier_changes s WHERE ${active}`);
  }
  return sources.length ? sources.join(' UNION ALL ') : null;
}

export async function localPurchasePayablesSql(client: PostgresClient) {
  return payablesSql(await purchaseDocumentTables(client));
}

export function readPurchasePayables<T>(fallback: T, read: (client: PostgresClient, source: string) => Promise<T>) {
  return readPurchaseDocuments(fallback, async (client, tables) => {
    const source = payablesSql(tables);
    return source ? read(client, source) : fallback;
  });
}

export async function readPurchaseDocuments<T>(
  fallback: T, read: (client: PostgresClient, tables: PurchaseDocumentTables) => Promise<T>,
) {
  if (!postgresConfigured()) return fallback;
  let client: PostgresClient | undefined;
  try {
    client = await connectPostgres();
    const tables = await purchaseDocumentTables(client);
    return tables.receipts || tables.expenses ? await read(client, tables) : fallback;
  } catch (error) {
    if (error instanceof ApplicationError) throw error;
    throw new ApplicationError('No fue posible consultar las cuentas por pagar en PostgreSQL.', 'PURCHASE_PAYABLES_UNAVAILABLE', 503);
  } finally {
    client?.release();
  }
}
