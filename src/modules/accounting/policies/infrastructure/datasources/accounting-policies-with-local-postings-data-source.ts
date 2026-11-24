import type { RowDataPacket } from 'mysql2/promise';
import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import { legacyMysqlPool } from '../../../../../shared/infrastructure/database/legacy-mysql-pool.js';
import { connectPostgres, postgresConfigured, type PostgresClient } from '../../../../../shared/infrastructure/database/postgres-pool.js';
import { isLocalSupplierPaymentId } from '../../../../accounts-payable/suppliers/infrastructure/datasources/postgres-supplier-payments.js';
import { isLocalCustomerCollectionId } from '../../../../accounts-receivable/clients/infrastructure/datasources/postgres-customer-collections.js';
import { customerCollectionReversalsAvailable, isLocalCustomerCollectionReversalId } from '../../../../accounts-receivable/clients/infrastructure/datasources/customer-collection-reversal-reads.js';
import { isLocalPurchaseReceptionId } from '../../../../purchasing/purchase-receptions/infrastructure/datasources/postgres-purchase-reception-writes.js';
import { isLocalPurchaseExpenseBatchId } from '../../../../purchasing/purchase-receptions/infrastructure/datasources/postgres-purchase-expenses.js';
import { localPurchasePayablesSql, paymentDocumentIdSql } from '../../../../purchasing/purchase-receptions/infrastructure/datasources/postgres-purchase-payables.js';
import {
  isLocalPurchaseExpenseCancellationId, isLocalPurchaseReceptionCancellationId, isLocalSupplierPaymentReversalId,
  purchaseExpenseCancellationsAvailable, purchaseReceptionCancellationsAvailable, supplierPaymentReversalsAvailable,
} from '../../../../purchasing/purchase-receptions/infrastructure/datasources/purchase-posting-reversal-tables.js';
import { bankReconciliationsAvailable, joinBankReconciliation } from '../../../../treasury/banking/infrastructure/datasources/bank-reconciliation-reads.js';
import { isLocalBankTransferId } from '../../../../treasury/banking/infrastructure/datasources/postgres-bank-transfers.js';
import type { AccountingPoliciesDataSource } from '../../domain/datasources/accounting-policies-data-source.js';
import { AccountingPolicy, type AccountingPolicyCommentMetadata, type AccountingPolicyMovement } from '../../domain/entities/accounting-policy.js';
import type {
  AccountingPolicyNavigationDirection, AccountingPolicySearchCriteria, AccountingPolicySearchResult,
} from '../../domain/repositories/accounting-policies-repository.js';
import type { LegacyMysqlAccountingPoliciesDataSource } from './legacy-mysql-accounting-policies-data-source.js';
import { isManualPolicyId, manualLineSettlement, manualPoliciesAvailable, manualPolicyCommentFields } from './manual-policy-reads.js';

interface LocalPolicyHeader {
  id: number;
  number: string;
  company: number;
  userId: number;
  date: string;
  cheque: string;
  beneficiary: string;
  family: string;
  concept: string;
  auditAt: string;
  exchangeRate: number;
  applied?: boolean;
  manual?: { revision: number; canceled: boolean; reconciled: boolean } | null;
  commentMetadata?: AccountingPolicyCommentMetadata | null;
}

interface LocalPolicyRecord extends LocalPolicyHeader {
  lines: {
    account: string; department: string; debit: number; credit: number;
    id?: number; reference?: string; accountName?: string; accountId?: number; accountType?: number; reconciled?: boolean;
  }[];
}

interface AccountRow extends RowDataPacket {
  id: number;
  code: string;
  name: string;
  type: number;
}

const receiptFields = `
    id, accounting->>'number' AS number, company_id AS company, user_id AS "userId",
    result #>> '{reception,dates,receivedAt}' AS date, number AS cheque,
    result #>> '{reception,supplier,name}' AS beneficiary, 'COMPRAS'::text AS family,
    concat('Recepción ', number, '  Referencia ', result #>> '{reception,supplierReference}', ' O.C. ', order_number) AS concept,
    created_at AS "auditAt", coalesce((payable->>'exchangeRate')::numeric, 1)::float8 AS "exchangeRate"`;
const receiptCancellationFields = `
    cancellation.id,cancellation.policy_number AS number,cancellation.company_id AS company,cancellation.user_id AS "userId",
    cancellation.date::text AS date,coalesce(r.number,to_jsonb(cancellation)#>>'{historical_source,number}') AS cheque,
    coalesce(r.result #>> '{reception,supplier,name}',to_jsonb(cancellation)#>>'{historical_source,supplierName}') AS beneficiary,'COMPRAS CANC'::text AS family,
    concat('Cancelación de recepción ', coalesce(r.number,to_jsonb(cancellation)#>>'{historical_source,number}'), ' · ', cancellation.reason) AS concept,
    cancellation.created_at AS "auditAt",1::float8 AS "exchangeRate"`;
const paymentFields = `
    posting.id, posting.policy_number AS number, posting.company_id AS company, posting.user_id AS "userId",
    posting.date::text AS date, posting.number AS cheque,
    receipt.supplier_name AS beneficiary, 'PAGOS PR.'::text AS family,
    posting.description AS concept, posting.created_at AS "auditAt",
    receipt.exchange_rate::float8 AS "exchangeRate"`;
const expenseFields = `
    id, policy_number AS number, company_id AS company, user_id AS "userId",
    date::text AS date, reference AS cheque, beneficiary,'GASTOS MULTIPLE'::text AS family,
    description AS concept,created_at AS "auditAt",1::float8 AS "exchangeRate"`;
const paymentLines = `jsonb_build_array(
    jsonb_build_object('account', posting.bank_code, 'accountId', posting.bank_account_id,
      'accountName', posting.bank_name, 'department', '', 'debit', 0, 'credit', posting.amount,
      'reconciled', settlement.statement_date IS NOT NULL),
    jsonb_build_object('account', posting.supplier_account, 'accountName', posting.supplier_account_name,
      'department', '', 'debit', posting.amount, 'credit', 0, 'reference', receipt.number)
  )`;
const paymentReversalFields = `
    reversal.id, reversal.policy_number AS number, reversal.company_id AS company, reversal.user_id AS "userId",
    reversal.date::text AS date, reversal.number AS cheque,
    receipt.supplier_name AS beneficiary, 'REVERSIÓN PP'::text AS family,
    concat('Reversión de ', posting.policy_number, ' · ', reversal.reason) AS concept,
    reversal.created_at AS "auditAt", receipt.exchange_rate::float8 AS "exchangeRate"`;
const paymentReversalLines = `jsonb_build_array(
    jsonb_build_object('account', posting.bank_code, 'accountId', posting.bank_account_id,
      'accountName', posting.bank_name, 'department', '', 'debit', posting.amount, 'credit', 0,
      'reference', posting.policy_number, 'reconciled', correction_settlement.statement_date IS NOT NULL),
    jsonb_build_object('account', posting.supplier_account, 'accountName', posting.supplier_account_name,
      'department', '', 'debit', 0, 'credit', posting.amount, 'reference', receipt.number)
  )`;
const expenseCancellationFields = `
    cancellation.id, cancellation.policy_number AS number, cancellation.company_id AS company, cancellation.user_id AS "userId",
    cancellation.date::text AS date, batch.reference AS cheque, batch.beneficiary, 'CANCELACIÓN GA'::text AS family,
    concat('Cancelación de ', batch.policy_number, ' · ', cancellation.reason) AS concept,
    cancellation.created_at AS "auditAt", 1::float8 AS "exchangeRate"`;
const expenseCancellationLines = `(
    SELECT jsonb_agg(line.value || jsonb_build_object('debit',line.value->'credit','credit',line.value->'debit')
                     ORDER BY line.position)
    FROM jsonb_array_elements(batch.accounting_lines) WITH ORDINALITY AS line(value,position)
  )`;
const collectionFields = `
    posting.id, posting.policy_number AS number, posting.company_id AS company, posting.user_id AS "userId",
    posting.date::text AS date, coalesce(nullif(posting.reference,''),posting.number) AS cheque,
    remission.result #>> '{invoice,customer,name}' AS beneficiary, 'COBRANZA'::text AS family,
    posting.description AS concept, posting.created_at AS "auditAt", 1::float8 AS "exchangeRate"`;
const collectionLines = `jsonb_build_array(
    jsonb_build_object('account', posting.bank_code, 'accountId', posting.bank_account_id,
      'accountName', posting.bank_name, 'department', '', 'debit', posting.amount, 'credit', 0,
      'reconciled', settlement.statement_date IS NOT NULL),
    jsonb_build_object('account', posting.client_account, 'accountName', posting.client_account_name,
      'department', '', 'debit', 0, 'credit', posting.amount, 'reference', remission.number)
  )`;
const collectionReversalFields = `
    reversal.id,reversal.policy_number AS number,reversal.company_id AS company,reversal.user_id AS "userId",
    reversal.date::text AS date,reversal.number AS cheque,remission.result #>> '{invoice,customer,name}' AS beneficiary,
    'COBRANZA'::text AS family,concat('Reversión de cobranza ',posting.policy_number,' · ',reversal.reason) AS concept,
    reversal.created_at AS "auditAt",1::float8 AS "exchangeRate"`;
const collectionReversalLines = `jsonb_build_array(
    jsonb_build_object('account',posting.bank_code,'accountId',posting.bank_account_id,'accountName',posting.bank_name,
      'department','','debit',0,'credit',posting.amount,'reference',posting.policy_number,
      'reconciled',correction_settlement.statement_date IS NOT NULL),
    jsonb_build_object('account',posting.client_account,'accountName',posting.client_account_name,
      'department','','debit',posting.amount,'credit',0,'reference',remission.number)
  )`;
const transferFields = `
    transfer.id, transfer.policy_number AS number, transfer.company_id AS company, transfer.user_id AS "userId",
    transfer.date::text AS date, coalesce(nullif(transfer.reference,''),transfer.number) AS cheque,
    transfer.beneficiary, ''::text AS family, transfer.description AS concept,
    transfer.created_at AS "auditAt", 1::float8 AS "exchangeRate"`;
const transferLines = (settlements: string) => `(
    SELECT jsonb_agg(jsonb_build_object(
      'id', posting.id, 'account', posting.bank_code, 'accountId', posting.bank_account_id,
      'accountName', posting.bank_name, 'department', '',
      'debit', greatest(posting.amount, 0), 'credit', greatest(-posting.amount, 0),
      'reference', CASE WHEN transfer.result->>'mode'='check' THEN '' ELSE transfer.reference END,
      'reconciled', settlement.statement_date IS NOT NULL
    ) ORDER BY posting.id)
    FROM tuvansa.bank_transfer_movements AS posting
    ${settlements}
    WHERE posting.transfer_id=transfer.id AND posting.company_id=transfer.company_id
  )`;
const money = (amount: number) => Number(amount.toFixed(2));
const isLocalPolicyId = (id: number) =>
  isLocalPurchaseReceptionId(id) || isLocalPurchaseExpenseBatchId(id) || isLocalSupplierPaymentId(id)
    || isLocalCustomerCollectionId(id) || isLocalCustomerCollectionReversalId(id) || isLocalBankTransferId(id)
    || isLocalPurchaseExpenseCancellationId(id) || isLocalPurchaseReceptionCancellationId(id) || isLocalSupplierPaymentReversalId(id)
    || isManualPolicyId(id);

async function readLocalPolicies<T>(
  fallback: T, detail: boolean, read: (client: PostgresClient, view: string) => Promise<T>,
): Promise<T> {
  if (!postgresConfigured()) return fallback;
  let client: PostgresClient | undefined;
  try {
    client = await connectPostgres();
    const { rows: [tables] } = await client.query<{ receipts: boolean; expenses: boolean; payments: boolean; collections: boolean; transfers: boolean }>(
      `SELECT to_regclass('tuvansa.purchase_receptions') IS NOT NULL AS receipts,
              to_regclass('tuvansa.purchase_expense_batches') IS NOT NULL AS expenses,
              to_regclass('tuvansa.supplier_payments') IS NOT NULL AS payments,
              to_regclass('tuvansa.customer_collections') IS NOT NULL AS collections,
              to_regclass('tuvansa.bank_transfers') IS NOT NULL
                AND to_regclass('tuvansa.bank_transfer_movements') IS NOT NULL AS transfers`,
    );
    const withLines = (sql: string) => detail ? sql : "'[]'::jsonb";
    const settlementDetails = detail && (tables?.payments || tables?.collections || tables?.transfers);
    const hasSettlements = settlementDetails ? await bankReconciliationsAvailable(client) : false;
    const settlements = settlementDetails ? joinBankReconciliation(hasSettlements) : '';
    const views: string[] = [];
    if (tables?.receipts) views.push(
      `SELECT ${receiptFields}, ${withLines("accounting->'lines'")} AS lines
       FROM tuvansa.purchase_receptions WHERE company_id = 1 AND accounting IS NOT NULL`,
    );
    if (tables?.receipts && await purchaseReceptionCancellationsAvailable(client)) views.push(
      `SELECT ${receiptCancellationFields}, ${withLines("cancellation.accounting->'lines'")} AS lines
       FROM tuvansa.purchase_reception_cancellations cancellation
       LEFT JOIN tuvansa.purchase_receptions r ON r.id=cancellation.receipt_id AND r.company_id=cancellation.company_id
       WHERE cancellation.company_id=1`,
    );
    if (tables?.expenses) views.push(
      `SELECT ${expenseFields}, ${withLines('accounting_lines')} AS lines
       FROM tuvansa.purchase_expense_batches WHERE company_id=1`,
    );
    if (tables?.expenses && await purchaseExpenseCancellationsAvailable(client)) views.push(
      `SELECT ${expenseCancellationFields}, ${withLines(expenseCancellationLines)} AS lines
       FROM tuvansa.purchase_expense_cancellations cancellation
       JOIN tuvansa.purchase_expense_batches batch ON batch.id=cancellation.batch_id AND batch.company_id=cancellation.company_id
       WHERE cancellation.company_id=1`,
    );
    const payables = tables?.payments ? await localPurchasePayablesSql(client) : null;
    if (payables) views.push(
      `SELECT ${paymentFields}, ${withLines(paymentLines)} AS lines FROM tuvansa.supplier_payments AS posting
       JOIN (${payables}) AS receipt ON receipt.id=${paymentDocumentIdSql('posting')}
         AND receipt.company_id=posting.company_id AND receipt.supplier_id=posting.supplier_id
       ${settlements} WHERE posting.company_id = 1`,
    );
    if (payables && await supplierPaymentReversalsAvailable(client)) views.push(
      `SELECT ${paymentReversalFields}, ${withLines(paymentReversalLines)} AS lines
       FROM tuvansa.supplier_payment_reversals reversal
       JOIN tuvansa.supplier_payments posting ON posting.id=reversal.payment_id AND posting.company_id=reversal.company_id
       JOIN (${payables}) receipt ON receipt.id=${paymentDocumentIdSql('posting')}
         AND receipt.company_id=posting.company_id AND receipt.supplier_id=posting.supplier_id
       ${detail ? joinBankReconciliation(hasSettlements, 'reversal', 'correction_settlement', 'posting') : ''}
       WHERE reversal.company_id=1`,
    );
    if (tables?.collections) views.push(
      `SELECT ${collectionFields}, ${withLines(collectionLines)} AS lines FROM tuvansa.customer_collections AS posting
       JOIN tuvansa.sales_remissions AS remission ON remission.id = posting.remission_id AND remission.company_id = posting.company_id
       ${settlements} WHERE posting.company_id = 1`,
    );
    if (tables?.collections && await customerCollectionReversalsAvailable(client)) views.push(
      `SELECT ${collectionReversalFields},${withLines(collectionReversalLines)} AS lines
       FROM tuvansa.customer_collection_reversals reversal
       JOIN tuvansa.customer_collections posting ON posting.id=reversal.collection_id AND posting.company_id=reversal.company_id
       JOIN tuvansa.sales_remissions remission ON remission.id=posting.remission_id AND remission.company_id=posting.company_id
       ${joinBankReconciliation(hasSettlements, 'reversal', 'correction_settlement', 'posting')}
       WHERE reversal.company_id=1`,
    );
    if (tables?.transfers) views.push(
      `SELECT ${transferFields}, ${withLines(transferLines(settlements))} AS lines
       FROM tuvansa.bank_transfers AS transfer WHERE transfer.company_id=1`,
    );
    const projections = views.length ? [`SELECT postings.*,true AS applied,NULL::jsonb AS manual,NULL::jsonb AS "commentMetadata"
      FROM (${views.join(' UNION ALL ')}) postings`] : [];
    if (await manualPoliciesAvailable(client)) {
      const reconciled = manualLineSettlement(await bankReconciliationsAvailable(client));
      projections.push(`SELECT p.id,p.number,p.company_id AS company,0 AS "userId",p.date::text AS date,
        coalesce(to_jsonb(p)#>>'{comment_metadata,cheque}','') AS cheque,
        p.beneficiary,p.family,p.concept,p.updated_at AS "auditAt",1::float8 AS "exchangeRate",
        ${detail ? 'lineInfo.lines' : "'[]'::jsonb"} AS lines,p.applied,
        jsonb_build_object('revision',p.revision,'canceled',p.canceled_at IS NOT NULL,'reconciled',lineInfo.reconciled) AS manual,
        to_jsonb(p)->'comment_metadata' AS "commentMetadata"
        FROM tuvansa.manual_accounting_policies p CROSS JOIN LATERAL (
          SELECT coalesce(bool_or(settlement.statement_date IS NOT NULL),false) AS reconciled,
            ${detail ? `coalesce(jsonb_agg(jsonb_build_object('id',l.id,'account',l.account->>'code','accountId',l.account_id,
              'accountName',l.account->>'name','accountType',l.account_type,'department',l.cost_center,'debit',l.debit,'credit',l.credit,
              'reference',l.reference,'reconciled',settlement.statement_date IS NOT NULL) ORDER BY l.position),'[]'::jsonb)` : "'[]'::jsonb"} AS lines
          FROM tuvansa.manual_accounting_policy_lines l ${reconciled} WHERE l.policy_id=p.id
        ) lineInfo WHERE p.company_id=1`);
    }
    return projections.length ? await read(client, projections.join(' UNION ALL ')) : fallback;
  } catch (error) {
    if (error instanceof ApplicationError) throw error;
    throw new ApplicationError('No fue posible consultar las pólizas en PostgreSQL.', 'ACCOUNTING_POLICY_POSTGRES_UNAVAILABLE', 503);
  } finally {
    client?.release();
  }
}

function localPolicy(header: LocalPolicyHeader, movements: AccountingPolicyMovement[] = []): AccountingPolicy {
  const { id, number, company, userId, date, cheque, beneficiary, family, concept, auditAt, exchangeRate } = header;
  const debit = money(movements.reduce((sum, line) => sum + line.debit, 0));
  const credit = money(movements.reduce((sum, line) => sum + line.credit, 0));
  return AccountingPolicy.create({
    id, number, date, cheque, company, userId, origin: header.manual ? 'DIARIO' : family, applied: header.applied ?? true, beneficiary, family, concept,
    amountInWords: '', report: '', auditAt, postDate: null, classifications: ['', ''], exchangeRate, usedAt: null,
    totals: { debit, credit, difference: money(debit - credit) }, movements,
    ...(header.manual ? { manual: header.manual, ...manualPolicyCommentFields(header.commentMetadata) } : {}),
  });
}

function comparePolicyNumbers(left: string, right: string): number {
  const normalizedLeft = left.toUpperCase();
  const normalizedRight = right.toUpperCase();
  return normalizedLeft < normalizedRight ? -1 : Number(normalizedLeft > normalizedRight);
}

async function policyWithMovements(record: LocalPolicyRecord): Promise<AccountingPolicy> {
  if (record.lines.length === 0) return localPolicy(record);
  const codes = [...new Set(record.lines.map(({ account }) => account))];
  // Derivada. Completa las cuentas de la póliza web con el catálogo de Contabilidad.
  const [rows] = record.manual ? [[]] : await legacyMysqlPool.query<AccountRow[]>(
    'SELECT BSEQ AS id, BCOD AS code, BNOMBRE AS name, BTIPO AS type FROM FBENC WHERE BCOD IN (?) ORDER BY BSEQ', [codes],
  );
  const accounts = new Map<string, AccountRow>();
  for (const row of rows) {
    const code = row.code.trim();
    if (!accounts.has(code)) accounts.set(code, row);
  }
  return localPolicy(record, record.lines.map(({ id, account, accountId, accountName, accountType, department, debit, credit, reference, reconciled }, index) => {
    const details = accounts.get(account);
    return {
      id: id ?? index + 1, accountId: accountId ?? details?.id ?? 0, accountCode: account, accountName: accountName ?? details?.name ?? '',
      debit, credit, reference: reference ?? '', exchangeRate: record.exchangeRate, costCenter: Number(department) || 0,
      reconciled: reconciled ?? false, accountType: accountType ?? details?.type ?? 0,
    };
  }));
}

export class AccountingPoliciesWithLocalPostingsDataSource implements AccountingPoliciesDataSource {
  constructor(private readonly legacy: LegacyMysqlAccountingPoliciesDataSource) {}

  private record(field: 'id' | 'number', value: number | string) {
    const filter = field === 'id' ? 'id' : 'upper(number)';
    return readLocalPolicies<LocalPolicyRecord | null>(null, true, async (client, view) => {
      const { rows: [row] } = await client.query<{ policy: LocalPolicyRecord }>(
        `SELECT to_jsonb(entry) AS policy FROM (${view}) AS entry WHERE ${filter} = $1`, [value],
      );
      return row?.policy ?? null;
    });
  }

  async findById(id: number) {
    if (!isLocalPolicyId(id)) return this.legacy.findById(id);
    const local = await this.record('id', id);
    return local ? policyWithMovements(local) : null;
  }

  async findByNumber(number: string) {
    const local = await this.record('number', number.toUpperCase());
    return local ? policyWithMovements(local) : this.legacy.findByNumber(number);
  }

  private searchLocal(criteria: AccountingPolicySearchCriteria, filtered: boolean, offset: number, limit: number) {
    const conditions = [];
    const values: (string | number)[] = [];
    if (criteria.query !== undefined) {
      values.push(`%${criteria.query}%`);
      conditions.push('(number ILIKE $1 OR concept ILIKE $1 OR beneficiary ILIKE $1 OR cheque ILIKE $1)');
    }
    for (const [field, filter] of [['number', criteria.number], ['cheque', criteria.cheque]] as const) {
      if (filter === undefined) continue;
      values.push(`${filter}%`);
      conditions.push(`${field} ILIKE $${values.length}`);
    }
    if (criteria.family !== undefined) {
      values.push(`${criteria.family}%`);
      conditions.push(`family ILIKE $${values.length}`);
    }
    if (criteria.date !== undefined) {
      values.push(criteria.date);
      conditions.push(`date = $${values.length}`);
    }
    if (criteria.applied !== undefined) conditions.push(criteria.applied ? 'applied' : 'NOT applied');
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const order = filtered ? 'upper(number), id' : '"auditAt" DESC, id DESC';
    values.push(offset, limit);
    return readLocalPolicies<{ items: LocalPolicyHeader[]; total: number }>({ items: [], total: 0 }, false, async (client, view) => {
      // Derivada. Proyecta las pólizas registradas con recepciones, pagos y cobranza.
      const { rows: [row] } = await client.query<{ items: LocalPolicyHeader[]; total: string }>(
        `WITH policies AS (${view}),
              matched AS (SELECT * FROM policies ${where})
         SELECT (SELECT count(*) FROM matched) AS total,
                ARRAY(SELECT to_jsonb(matched) FROM matched
                      ORDER BY ${order} OFFSET $${values.length - 1} LIMIT $${values.length}) AS items`, values,
      );
      return { items: row?.items ?? [], total: Number(row?.total ?? 0) };
    });
  }

  async search(criteria: AccountingPolicySearchCriteria): Promise<AccountingPolicySearchResult> {
    const { offset, limit } = criteria;
    const filtered = [criteria.query, criteria.number, criteria.date, criteria.applied, criteria.family, criteria.cheque]
      .some((value) => value !== undefined);
    const local = await this.searchLocal(criteria, filtered, filtered ? 0 : offset, filtered ? offset + limit : limit);
    if (local.total === 0) return this.legacy.search(criteria);
    if (!filtered) {
      // New local postings precede the historical ledger in the default order.
      const legacy = await this.legacy.search({ ...criteria, offset: Math.max(offset - local.total, 0), limit: limit - local.items.length });
      return { items: [...local.items.map((header) => localPolicy(header)), ...legacy.items], total: local.total + legacy.total };
    }

    // Every legacy row before this offset is also before the requested combined page.
    const legacyOffset = Math.max(offset - local.total, 0);
    const legacy = await this.legacy.search({ ...criteria, offset: legacyOffset, limit: offset + limit - legacyOffset });
    const merged = [
      ...local.items.map((header) => ({ id: header.id, number: header.number, entity: localPolicy(header) })),
      ...legacy.items.map((entity) => {
        const { id, number } = entity.toPrimitives();
        return { id, number, entity };
      }),
    ].sort((left, right) => comparePolicyNumbers(left.number, right.number) || left.id - right.id);
    return {
      items: merged.slice(offset - legacyOffset, offset + limit - legacyOffset).map(({ entity }) => entity),
      total: local.total + legacy.total,
    };
  }

  async findAdjacent(id: number, direction: AccountingPolicyNavigationDirection) {
    const number = isLocalPolicyId(id)
      ? (await this.record('id', id))?.number ?? null
      : await this.legacy.findNumberById(id);
    if (number === null) return null;
    const previous = direction === 'previous';
    const [local, legacy] = await Promise.all([
      readLocalPolicies<LocalPolicyRecord | null>(null, true, async (client, view) => {
        const order = previous ? 'DESC' : 'ASC';
        const { rows: [row] } = await client.query<{ policy: LocalPolicyRecord }>(
          `SELECT to_jsonb(entry) AS policy FROM (${view}) AS entry
           WHERE upper(number) ${previous ? '<' : '>'} $1
           ORDER BY upper(number) ${order}, id ${order} LIMIT 1`,
          [number.toUpperCase()],
        );
        return row?.policy ?? null;
      }),
      this.legacy.findAdjacentByNumber(number, direction),
    ]);

    if (!local) return legacy;
    if (legacy) {
      const comparison = comparePolicyNumbers(local.number, legacy.toPrimitives().number);
      if (previous ? comparison < 0 : comparison > 0) return legacy;
    }
    return policyWithMovements(local);
  }

  async getClassifications(id: number) {
    if (!isLocalPolicyId(id)) return this.legacy.getClassifications(id);
    const local = await this.record('id', id);
    return local ? this.legacy.getClassificationCatalog(localPolicy(local)) : null;
  }
}
