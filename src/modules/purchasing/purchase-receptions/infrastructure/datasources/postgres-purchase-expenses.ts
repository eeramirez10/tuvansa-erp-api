import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import { ConflictError } from '../../../../../shared/domain/errors/conflict-error.js';
import {
  connectPostgres, postgresConfigured, type PostgresClient, type PostgresConnectionFactory,
} from '../../../../../shared/infrastructure/database/postgres-pool.js';
import { migratePostgres } from '../../../../../shared/infrastructure/datasources/postgres-schema.js';
import type { ExpensePosting, ExpenseResult, ExpenseStorage } from '../../domain/datasources/purchase-expense-data-source.js';

const batchIdStart = 7900000000000;
const documentIdStart = 7910000000000;
const seriesLength = 99999999;
export const isLocalPurchaseExpenseBatchId = (id: number) => id >= batchIdStart && id < batchIdStart + seriesLength;
export const isLocalPurchaseExpenseDocumentId = (id: number) => id >= documentIdStart && id < documentIdStart + seriesLength;

const migrations = [{ id: 'purchase_expense_batches', sql: `
  CREATE SEQUENCE tuvansa.purchase_expense_batch_ids START WITH ${batchIdStart} MAXVALUE ${batchIdStart + seriesLength - 1};
  CREATE SEQUENCE tuvansa.purchase_expense_document_ids START WITH ${documentIdStart} MAXVALUE ${documentIdStart + seriesLength - 1};
  CREATE TABLE tuvansa.purchase_expense_batches (
    id bigint PRIMARY KEY,
    company_id integer NOT NULL CHECK (company_id = 1),
    user_id integer NOT NULL CHECK (user_id >= 0),
    request_key uuid NOT NULL,
    fingerprint char(64) NOT NULL,
    policy_number varchar(11) UNIQUE NOT NULL,
    date date NOT NULL,
    reference varchar(13) NOT NULL,
    beneficiary varchar(85) NOT NULL,
    description varchar(90) NOT NULL,
    accounting_lines jsonb NOT NULL CHECK (jsonb_typeof(accounting_lines) = 'array'),
    result jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(company_id,request_key),
    UNIQUE(id,company_id)
  );
  CREATE TABLE tuvansa.purchase_expense_documents (
    id bigint PRIMARY KEY,
    batch_id bigint NOT NULL,
    company_id integer NOT NULL,
    supplier_id bigint NOT NULL,
    supplier_code varchar(6) NOT NULL,
    supplier_name varchar(80) NOT NULL,
    supplier_account varchar(16) NOT NULL,
    supplier_account_name varchar(40) NOT NULL,
    number varchar(13) UNIQUE NOT NULL,
    reference varchar(23) NOT NULL,
    date date NOT NULL,
    due_date date NOT NULL,
    amount numeric(18,2) NOT NULL CHECK (amount > 0),
    base numeric(18,2) NOT NULL,
    vat numeric(18,2) NOT NULL,
    vat_withholding numeric(18,2) NOT NULL,
    income_withholding numeric(18,2) NOT NULL,
    lines jsonb NOT NULL CHECK (jsonb_typeof(lines) = 'array'),
    CHECK (due_date >= date AND amount = base + vat - vat_withholding - income_withholding),
    FOREIGN KEY (batch_id,company_id) REFERENCES tuvansa.purchase_expense_batches(id,company_id)
  );
  CREATE INDEX purchase_expense_documents_batch ON tuvansa.purchase_expense_documents(batch_id,id);
  CREATE INDEX purchase_expense_documents_supplier ON tuvansa.purchase_expense_documents(company_id,supplier_id,due_date,id);
  CREATE INDEX purchase_expense_documents_reference ON tuvansa.purchase_expense_documents(upper(reference)) WHERE reference<>'';
` }];

export const ensurePurchaseExpenseSchema = (client: PostgresClient) => migratePostgres(client, migrations);

export async function purchaseExpensesAvailable(client: PostgresClient): Promise<boolean> {
  const { rows: [table] } = await client.query<{ available: boolean }>(
    "SELECT to_regclass('tuvansa.purchase_expense_documents') IS NOT NULL AS available",
  );
  return table?.available ?? false;
}

const databaseUnavailable = () => new ApplicationError(
  'No fue posible registrar los gastos en PostgreSQL.', 'PURCHASE_EXPENSE_POSTGRES_UNAVAILABLE', 503,
);

async function priorRequest(client: PostgresClient, companyId: number, requestKey: string, fingerprint: string): Promise<ExpenseResult | null> {
  const { rows: [row] } = await client.query<{ fingerprint: string; result: ExpenseResult }>(
    'SELECT fingerprint,result FROM tuvansa.purchase_expense_batches WHERE company_id=$1 AND request_key=$2', [companyId, requestKey],
  );
  if (!row) return null;
  if (row.fingerprint !== fingerprint) throw new ConflictError('La solicitud ya se usó con otros datos.', 'PURCHASE_EXPENSE_REQUEST_CONFLICT');
  return row.result;
}

export class PostgresPurchaseExpenses implements ExpenseStorage {
  private migration?: Promise<void>;

  constructor(private readonly connect: PostgresConnectionFactory = connectPostgres, private readonly configured = postgresConfigured) {}

  writable() { return this.configured(); }

  async findRequest(companyId: number, requestKey: string, fingerprint: string) {
    if (!this.writable()) return null;
    let client: PostgresClient | undefined;
    try {
      client = await this.connect();
      return await purchaseExpensesAvailable(client) ? await priorRequest(client, companyId, requestKey, fingerprint) : null;
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      throw databaseUnavailable();
    } finally { client?.release(); }
  }

  private async prepareSchema() {
    const client = await this.connect();
    try { await ensurePurchaseExpenseSchema(client); } finally { client.release(); }
  }

  async commit({ actor, input, fingerprint, documents, accountingLines }: ExpensePosting): Promise<ExpenseResult> {
    this.migration ??= this.prepareSchema().catch(() => {
      delete this.migration;
      throw databaseUnavailable();
    });
    await this.migration;
    let client: PostgresClient | undefined;
    try {
      client = await this.connect();
      await client.query('BEGIN');
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('purchase-expense-request:'||$1||':'||$2,0))",
        [String(actor.companyId), input.requestKey]);
      const replay = await priorRequest(client, actor.companyId, input.requestKey, fingerprint);
      if (replay) {
        await client.query('COMMIT');
        return replay;
      }
      const references = [...new Set(documents.map(({ reference }) => reference.toUpperCase()).filter(Boolean))].sort();
      for (const reference of references) {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended('purchase-expense-reference:'||$1,0))", [reference]);
      }
      const { rows: [duplicate] } = await client.query<{ reference: string }>(
        "SELECT reference FROM tuvansa.purchase_expense_documents WHERE reference<>'' AND upper(reference)=ANY($1::text[]) LIMIT 1", [references],
      );
      if (duplicate) throw new ConflictError(`Ya existe un documento con la referencia ${duplicate.reference}.`, 'PURCHASE_EXPENSE_REFERENCE_CONFLICT');

      const { rows: [batchId] } = await client.query<{ id: string }>("SELECT nextval('tuvansa.purchase_expense_batch_ids') AS id");
      const id = Number(batchId!.id);
      const policyNumber = `3GW${String(id - batchIdStart + 1).padStart(8, '0')}`;
      const { rows: docIds } = await client.query<{ id: string }>(
        "SELECT nextval('tuvansa.purchase_expense_document_ids') AS id FROM generate_series(1,$1::int)", [documents.length],
      );
      const result = {
        id, policyNumber,
        documents: documents.map(({ supplierId, supplierCode, supplierName, reference, total }, index) => {
          const docId = Number(docIds[index]!.id);
          return { id: docId, number: `GAW${String(docId - documentIdStart + 1).padStart(8, '0')}`, supplierId, supplierCode, supplierName, reference, total };
        }),
      };
      await client.query(
        `INSERT INTO tuvansa.purchase_expense_batches
         (id,company_id,user_id,request_key,fingerprint,policy_number,date,reference,beneficiary,description,accounting_lines,result)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb)`,
        [id, actor.companyId, actor.userId, input.requestKey, fingerprint, policyNumber, input.date, input.reference,
          input.beneficiary, input.description, JSON.stringify(accountingLines), JSON.stringify(result)],
      );
      for (const [index, doc] of documents.entries()) {
        const identity = result.documents[index]!;
        await client.query(
          `INSERT INTO tuvansa.purchase_expense_documents
           (id,batch_id,company_id,supplier_id,supplier_code,supplier_name,supplier_account,supplier_account_name,number,reference,
            date,due_date,amount,base,vat,vat_withholding,income_withholding,lines)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb)`,
          [identity.id, id, actor.companyId, doc.supplierId, doc.supplierCode, doc.supplierName, doc.account.code,
            doc.account.name, identity.number, doc.reference, input.date, doc.dueDate, doc.total, doc.base, doc.vat,
            doc.vatWithholding, doc.incomeWithholding, JSON.stringify(doc.lines)],
        );
      }
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client?.query('ROLLBACK').catch(() => undefined);
      if (error instanceof ApplicationError) throw error;
      throw databaseUnavailable();
    } finally { client?.release(); }
  }
}
