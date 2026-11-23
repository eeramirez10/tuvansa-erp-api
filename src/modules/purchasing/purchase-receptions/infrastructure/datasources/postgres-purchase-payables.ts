import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import { connectPostgres, postgresConfigured, type PostgresClient } from '../../../../../shared/infrastructure/database/postgres-pool.js';

// La columna nueva es opcional en respaldos que sólo registraron pagos de recepciones.
export const paymentDocumentIdSql = (alias: string) => `coalesce(${alias}.receipt_id,(to_jsonb(${alias})->>'expense_id')::bigint)`;

export interface PurchaseDocumentTables { receipts: boolean; expenses: boolean }

async function purchaseDocumentTables(client: PostgresClient): Promise<PurchaseDocumentTables> {
  const { rows: [tables] } = await client.query<PurchaseDocumentTables>(
    `SELECT to_regclass('tuvansa.purchase_receptions') IS NOT NULL AS receipts,
            to_regclass('tuvansa.purchase_expense_documents') IS NOT NULL AS expenses`,
  );
  return tables ?? { receipts: false, expenses: false };
}

function payablesSql(tables: PurchaseDocumentTables): string | null {
  const sources: string[] = [];
  if (tables.receipts) sources.push(`
    SELECT r.id,r.company_id,r.number,
      (r.result #>> '{reception,supplier,id}')::bigint AS supplier_id,
      r.result #>> '{reception,supplier,code}' AS supplier_code,
      r.result #>> '{reception,supplier,name}' AS supplier_name,
      nullif(r.result #>> '{reception,dates,receivedAt}','')::date AS received_at,
      nullif(r.payable->>'dueAt','')::date AS due_at,
      coalesce((r.payable->>'amount')::numeric,0) AS principal,
      coalesce((r.payable->>'currencyId')::integer,0) AS currency_id,
      coalesce((r.payable->>'exchangeRate')::numeric,0) AS exchange_rate,
      coalesce((r.result #>> '{reception,cancelled}')::boolean,false) AS cancelled,
      null::text AS supplier_account,null::text AS supplier_account_name,
      r.result #>> '{reception,supplierReference}' AS supplier_reference,r.order_number,
      r.movement #>> '{header,type}' AS movement_type,r.user_id,r.accounting->>'number' AS policy_number,
      CASE WHEN r.accounting IS NOT NULL THEN r.id END AS policy_id,r.created_at
    FROM tuvansa.purchase_receptions r WHERE r.number LIKE 'RW%'`);
  if (tables.expenses) sources.push(`
    SELECT d.id,d.company_id,d.number,d.supplier_id,d.supplier_code,d.supplier_name,
      d.date AS received_at,d.due_date AS due_at,d.amount AS principal,
      1 AS currency_id,1::numeric AS exchange_rate,false AS cancelled,d.supplier_account,d.supplier_account_name,
      d.reference AS supplier_reference,''::text AS order_number,'GA'::text AS movement_type,b.user_id,
      b.policy_number,b.id AS policy_id,b.created_at
    FROM tuvansa.purchase_expense_documents d
    JOIN tuvansa.purchase_expense_batches b ON b.id=d.batch_id AND b.company_id=d.company_id`);
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
