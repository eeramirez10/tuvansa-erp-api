import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import { ConflictError } from '../../../../../shared/domain/errors/conflict-error.js';
import { NotFoundError } from '../../../../../shared/domain/errors/not-found-error.js';
import {
  connectPostgres, postgresConfigured, type PostgresClient, type PostgresConnectionFactory,
} from '../../../../../shared/infrastructure/database/postgres-pool.js';
import { migratePostgres } from '../../../../../shared/infrastructure/datasources/postgres-schema.js';
import {
  isLocalSupplierPaymentId, supplierPaymentDocumentTable, supplierPaymentsAvailable,
} from '../../../../accounts-payable/suppliers/infrastructure/datasources/postgres-supplier-payments.js';
import { bankReconciliationsAvailable, bankReconciliationState } from '../../../../treasury/banking/infrastructure/datasources/bank-reconciliation-reads.js';
import type {
  PostingReversalCommand, PostingReversalDataSource, PostingReversalDocument, PostingReversalReconciliation, PostingReversalResult,
  PostingReversalSnapshot, PostingReversalTarget,
} from '../../domain/datasources/purchase-posting-reversal-data-source.js';
import { isLocalPurchaseExpenseDocumentId, purchaseExpensesAvailable } from './postgres-purchase-expenses.js';
import { localPurchasePayablesSql, paymentDocumentIdSql } from './postgres-purchase-payables.js';
import {
  postingReversalSeriesLength, purchaseExpenseCancellationIdStart, purchaseExpenseCancellationsAvailable,
  supplierPaymentReversalIdStart, supplierPaymentReversalsAvailable,
} from './purchase-posting-reversal-tables.js';

const targets = {
  payment: {
    table: 'supplier_payment_reversals', key: 'payment_id', source: 'supplier_payments', firstId: supplierPaymentReversalIdStart,
    policyPrefix: '2RV', available: supplierPaymentReversalsAvailable,
  },
  expense: {
    table: 'purchase_expense_cancellations', key: 'batch_id', source: 'purchase_expense_batches', firstId: purchaseExpenseCancellationIdStart,
    policyPrefix: '3GV', available: purchaseExpenseCancellationsAvailable,
  },
} as const;

type Kind = PostingReversalTarget['kind'];

function migrationFor(kind: Kind) {
  const { table, key, source, firstId } = targets[kind];
  return [{ id: table, sql: `
    CREATE SEQUENCE tuvansa.${table}_ids START WITH ${firstId} MAXVALUE ${firstId + postingReversalSeriesLength - 1};
    CREATE TABLE tuvansa.${table} (
      id bigint PRIMARY KEY,
      ${key} bigint NOT NULL UNIQUE REFERENCES tuvansa.${source}(id),
      company_id integer NOT NULL CHECK (company_id = 1),
      user_id integer NOT NULL CHECK (user_id >= 0),
      request_key uuid NOT NULL,
      fingerprint char(64) NOT NULL,
      date date NOT NULL,
      reason varchar(90) NOT NULL CHECK (length(trim(reason)) > 0),
      ${kind === 'payment' ? 'number varchar(11) NOT NULL UNIQUE,' : ''}
      policy_number varchar(11) NOT NULL UNIQUE,
      created_at timestamptz NOT NULL DEFAULT now(),
      result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
      UNIQUE(company_id,request_key)
    );
  ` }];
}

const unavailable = () => new ApplicationError(
  'No fue posible consultar o revertir el registro en PostgreSQL.', 'POSTING_REVERSAL_POSTGRES_UNAVAILABLE', 503,
);

type Header = Pick<PostingReversalSnapshot, 'targetId' | 'number' | 'policyNumber' | 'originalDate'>;
interface PaymentHeader extends Header { amount: number; bankAccountId: number; documentId: number; separateAccounts: boolean }

async function priorRequest(client: PostgresClient, kind: Kind, companyId: number, key: string, fingerprint: string) {
  const { rows: [saved] } = await client.query<{ fingerprint: string; result: PostingReversalResult }>(
    `SELECT fingerprint,result FROM tuvansa.${targets[kind].table} WHERE company_id=$1 AND request_key=$2`, [companyId, key],
  );
  if (saved && saved.fingerprint !== fingerprint) throw new ConflictError('La solicitud ya se usó con otros datos.', 'POSTING_REVERSAL_REQUEST_CONFLICT');
  return saved?.result ?? null;
}

async function alreadyRecorded(client: PostgresClient, kind: Kind, companyId: number, targetId: number) {
  const { table, key, available } = targets[kind];
  if (!await available(client)) return null;
  const { rows: [row] } = await client.query<{ result: PostingReversalResult }>(
    `SELECT result FROM tuvansa.${table} WHERE company_id=$1 AND ${key}=$2`, [companyId, targetId],
  );
  return row?.result ?? null;
}

async function paymentBankCut(client: PostgresClient, companyId: number, bankAccountId: number, paymentId: number) {
  if (!await bankReconciliationsAvailable(client)) return null;
  const { rows: [row] } = await client.query<{ id: number | null; date: string | null }>(
    `SELECT cut.id::float8 AS id,cut.statement_date::text AS date
     FROM tuvansa.bank_reconciliation_movements member
     LEFT JOIN tuvansa.bank_reconciliations cut ON cut.id=member.reconciliation_id
       AND cut.company_id=$1 AND cut.bank_account_id=$2
     WHERE member.movement_id=$3`, [companyId, bankAccountId, paymentId],
  );
  return row ?? null;
}

async function paymentSnapshot(client: PostgresClient, companyId: number,
  { supplierId, paymentId }: Extract<PostingReversalTarget, { kind: 'payment' }>, lock: boolean): Promise<PostingReversalSnapshot | null> {
  if (!isLocalSupplierPaymentId(paymentId) || !await supplierPaymentsAvailable(client)) return null;
  const { rows: [payment] } = await client.query<PaymentHeader>(
    `SELECT p.id::float8 AS "targetId",p.number,p.policy_number AS "policyNumber",p.date::text AS "originalDate",
       p.amount::float8 AS amount,p.bank_account_id::float8 AS "bankAccountId",${paymentDocumentIdSql('p')}::float8 AS "documentId",
       (p.bank_code<>p.supplier_account) AS "separateAccounts"
     FROM tuvansa.supplier_payments p WHERE p.id=$1 AND p.company_id=$2 AND p.supplier_id=$3`, [paymentId, companyId, supplierId],
  );
  if (!payment) return null;
  const { documentId, bankAccountId, separateAccounts, ...header } = payment;
  if (lock) {
    const table = supplierPaymentDocumentTable(documentId);
    await client.query(`SELECT id FROM tuvansa.${table} WHERE id=$1 AND company_id=$2 FOR UPDATE`, [documentId, companyId]);
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('bank-reconciliation:'||$1::text||':'||$2::text,0))", [companyId, bankAccountId]);
  }
  const source = await localPurchasePayablesSql(client);
  if (!source) return null;
  const { rows: [document] } = await client.query<PostingReversalDocument & { supportsPayment: boolean }>(
    `SELECT id::float8,number,principal::float8 AS total,(currency_id=1 AND exchange_rate=1) AS "supportsPayment"
     FROM (${source}) d WHERE id=$1 AND company_id=$2 AND supplier_id=$3`, [documentId, companyId, supplierId],
  );
  if (!document) return null;
  const { supportsPayment, ...affected } = document;
  const cut = await paymentBankCut(client, companyId, bankAccountId, paymentId);
  const originalReconciliation: PostingReversalReconciliation | null = cut?.id && cut.date && cut.date >= header.originalDate
    ? { id: cut.id, date: cut.date } : null;
  const lastStatementDate = originalReconciliation
    ? (await bankReconciliationState(client, companyId, bankAccountId)).lastStatementDate : null;
  const minimumDate = lastStatementDate ?? originalReconciliation?.date ?? header.originalDate;
  let blocked: string | null = null;
  if (!supportsPayment || !separateAccounts || payment.amount <= 0 || !/^2PW\d{8}$/.test(payment.policyNumber)) {
    blocked = 'El pago original requiere una reversión contable distinta.';
  } else if (cut && !originalReconciliation) {
    blocked = 'El vínculo con la conciliación original es inconsistente.';
  }
  return {
    ...header, minimumDate, originalReconciliation, documents: [affected], blocked,
    alreadyRecorded: await alreadyRecorded(client, 'payment', companyId, paymentId),
  };
}

interface ExpensePaymentStatus { active: boolean; lastReversalDate: string | null }

export async function getDocumentPaymentStatus(client: PostgresClient, companyId: number, ids: number[]): Promise<ExpensePaymentStatus> {
  if (!await supplierPaymentsAvailable(client)) return { active: false, lastReversalDate: null };
  const hasReversals = await supplierPaymentReversalsAvailable(client);
  const expressions = hasReversals
    ? 'count(*) FILTER (WHERE r.id IS NULL)>0 AS active,max(r.date)::text AS "lastReversalDate"'
    : 'count(*)>0 AS active,NULL::text AS "lastReversalDate"';
  const { rows: [row] } = await client.query<ExpensePaymentStatus>(
    `SELECT ${expressions} FROM tuvansa.supplier_payments p
      ${hasReversals ? 'LEFT JOIN tuvansa.supplier_payment_reversals r ON r.payment_id=p.id AND r.company_id=p.company_id' : ''}
      WHERE p.company_id=$1 AND ${paymentDocumentIdSql('p')}=ANY($2::bigint[]) AND p.amount>0`, [companyId, ids],
  );
  return row!;
}

async function expenseSnapshot(client: PostgresClient, companyId: number,
  { documentId }: Extract<PostingReversalTarget, { kind: 'expense' }>, lock: boolean): Promise<PostingReversalSnapshot | null> {
  if (!isLocalPurchaseExpenseDocumentId(documentId) || !await purchaseExpensesAvailable(client)) return null;
  const { rows: [header] } = await client.query<Header>(
    `SELECT b.id::float8 AS "targetId",d.number,b.policy_number AS "policyNumber",b.date::text AS "originalDate"
     FROM tuvansa.purchase_expense_documents d JOIN tuvansa.purchase_expense_batches b ON b.id=d.batch_id AND b.company_id=d.company_id
     WHERE d.id=$1 AND d.company_id=$2 ${lock ? 'FOR UPDATE OF b' : ''}`, [documentId, companyId],
  );
  if (!header) return null;
  const { rows: documents } = await client.query<PostingReversalDocument>(
    `SELECT id::float8,number,amount::float8 AS total FROM tuvansa.purchase_expense_documents
     WHERE batch_id=$1 AND company_id=$2 ORDER BY id ${lock ? 'FOR UPDATE' : ''}`, [header.targetId, companyId],
  );
  const { rows: [batchAmount] } = await client.query<{ amount: number }>(
    'SELECT sum(amount)::float8 AS amount FROM tuvansa.purchase_expense_documents WHERE batch_id=$1 AND company_id=$2', [header.targetId, companyId],
  );
  const { active, lastReversalDate } = await getDocumentPaymentStatus(client, companyId, documents.map(({ id }) => id));
  return {
    ...header, documents, amount: batchAmount!.amount,
    minimumDate: lastReversalDate && lastReversalDate > header.originalDate ? lastReversalDate : header.originalDate,
    blocked: active ? 'La póliza tiene documentos con un pago PP activo. Revierte primero esos pagos.' : null,
    alreadyRecorded: await alreadyRecorded(client, 'expense', companyId, header.targetId),
  };
}

function postingSnapshot(client: PostgresClient, companyId: number, target: PostingReversalTarget, lock: boolean) {
  if (companyId !== 1) return Promise.resolve(null);
  return target.kind === 'payment' ? paymentSnapshot(client, companyId, target, lock) : expenseSnapshot(client, companyId, target, lock);
}

export class PostgresPurchasePostingReversals implements PostingReversalDataSource {
  private readonly migrations: Partial<Record<Kind, Promise<void>>> = {};

  constructor(private readonly connect: PostgresConnectionFactory = connectPostgres, private readonly configured = postgresConfigured) {}

  private async withConnection<T>(work: (client: PostgresClient) => Promise<T>) {
    if (!this.configured()) throw unavailable();
    let client: PostgresClient | undefined;
    try {
      client = await this.connect();
      return await work(client);
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      throw unavailable();
    } finally { client?.release(); }
  }

  snapshot(companyId: number, target: PostingReversalTarget) {
    return this.withConnection((client) => postingSnapshot(client, companyId, target, false));
  }

  findRequest(companyId: number, { kind }: PostingReversalTarget, requestKey: string, fingerprint: string) {
    return this.withConnection(async (client) => await targets[kind].available(client)
      ? priorRequest(client, kind, companyId, requestKey, fingerprint) : null);
  }

  async commit({ actor, target, input, fingerprint, validate }: PostingReversalCommand): Promise<PostingReversalResult> {
    const { kind } = target;
    const { companyId, userId } = actor;
    const { table, key, firstId, policyPrefix } = targets[kind];
    this.migrations[kind] ??= this.withConnection((client) => migratePostgres(client, migrationFor(kind))).catch((error: unknown) => {
      delete this.migrations[kind];
      throw error;
    });
    await this.migrations[kind];
    return this.withConnection(async (client) => {
      await client.query('BEGIN');
      try {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1||':'||$2::text||':'||$3::text,0))",
          [table, companyId, input.requestKey.toLowerCase()]);
        const replay = await priorRequest(client, kind, companyId, input.requestKey, fingerprint);
        if (replay) {
          await client.query('COMMIT');
          return replay;
        }
        const snapshot = await postingSnapshot(client, companyId, target, true);
        if (!snapshot) throw new NotFoundError('Registro original');
        validate(snapshot);

        const { rows: [allocation] } = await client.query<{ id: string }>(`SELECT nextval('tuvansa.${table}_ids') AS id`);
        const id = Number(allocation!.id);
        const suffix = String(id - firstId + 1).padStart(8, '0');
        const result: PostingReversalResult = {
          id, policyNumber: `${policyPrefix}${suffix}`, date: input.date, reason: input.reason,
          ...(snapshot.originalReconciliation ? { originalReconciliation: snapshot.originalReconciliation } : {}),
        };
        const paymentNumber = kind === 'payment' ? [`RPW${suffix}`] : [];
        await client.query(
          `INSERT INTO tuvansa.${table} (id,${key},company_id,user_id,request_key,fingerprint,date,reason,policy_number,result${paymentNumber.length ? ',number' : ''})
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb${paymentNumber.length ? ',$11' : ''})`,
          [id, snapshot.targetId, companyId, userId, input.requestKey, fingerprint, input.date, input.reason,
            result.policyNumber, JSON.stringify(result), ...paymentNumber],
        );
        if (kind === 'payment') await removeBankTransit(client, companyId, [snapshot.targetId]);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      }
    });
  }
}
import { removeBankTransit } from '../../../../treasury/banking/infrastructure/datasources/bank-transit-reads.js';
