import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import { connectPostgres, postgresConfigured, type PostgresClient } from '../../../../../shared/infrastructure/database/postgres-pool.js';
import { bankReconciliationsAvailable } from '../../../../treasury/banking/infrastructure/datasources/bank-reconciliation-reads.js';
import type { ManualPolicyDocument } from '../../domain/datasources/manual-policy-data-source.js';
import type { AccountingPolicyCommentMetadata, AccountingPolicyProps } from '../../domain/entities/accounting-policy.js';

export const manualPolicyIdStart = 7990000000000;
export const manualPolicyLineIdStart = 8000000000000;
const range = 99999999;
export const isManualPolicyId = (id: number) => id >= manualPolicyIdStart && id < manualPolicyIdStart + range;
export const isManualPolicyLineId = (id: number) => id >= manualPolicyLineIdStart && id < manualPolicyLineIdStart + range;
export const manualPolicyLines = `FROM tuvansa.manual_accounting_policy_lines l
  JOIN tuvansa.manual_accounting_policies p ON p.id=l.policy_id AND p.company_id=1 AND p.canceled_at IS NULL`;
export const activeManualPolicyLines = `${manualPolicyLines} AND p.applied`;
export const manualPolicyAffectsAccount = `(l.account_id=$1 OR l.parents @> jsonb_build_array(jsonb_build_object('id',$1::bigint)))`;

export async function manualPoliciesAvailable(client: PostgresClient) {
  const { rows: [row] } = await client.query<{ available: boolean }>(
    "SELECT to_regclass('tuvansa.manual_accounting_policies') IS NOT NULL AS available",
  );
  return row?.available ?? false;
}

export async function readManualPolicies<T>(fallback: T, read: (client: PostgresClient) => Promise<T>): Promise<T> {
  if (!postgresConfigured()) return fallback;
  let client: PostgresClient | undefined;
  try {
    client = await connectPostgres();
    return await manualPoliciesAvailable(client) ? read(client) : fallback;
  } catch (error) {
    if (error instanceof ApplicationError) throw error;
    throw new ApplicationError('No fue posible consultar las pólizas de diario.', 'MANUAL_POLICY_POSTGRES_UNAVAILABLE', 503);
  } finally { client?.release(); }
}

export function manualLineSettlement(available: boolean) {
  return available ? `LEFT JOIN tuvansa.bank_reconciliation_movements matched ON matched.movement_id=l.id
      LEFT JOIN tuvansa.bank_reconciliations settlement ON settlement.id=matched.reconciliation_id
        AND settlement.company_id=1 AND settlement.bank_account_id=l.account_id`
    : 'CROSS JOIN (SELECT NULL::date AS statement_date) settlement';
}

export async function getManualPolicy(client: PostgresClient, id: number) {
  const { rows: [header] } = await client.query<Omit<ManualPolicyDocument, 'lines' | 'reconciled'>>(
    `SELECT id::float8,number,date::text,concept,beneficiary,family,revision,applied,(canceled_at IS NOT NULL) AS canceled,
       updated_at::text AS "updatedAt",to_jsonb(policy)->'comment_metadata' AS "commentMetadata"
     FROM tuvansa.manual_accounting_policies policy WHERE id=$1 AND company_id=1`, [id],
  );
  if (!header) return null;
  const settlement = manualLineSettlement(await bankReconciliationsAvailable(client));
  const { rows: lines } = await client.query<ManualPolicyDocument['lines'][number]>(
    `SELECT l.id::float8,l.account,l.parents,l.cost_center AS "costCenter",l.debit::float8,l.credit::float8,l.reference,
       settlement.statement_date IS NOT NULL AS reconciled
     FROM tuvansa.manual_accounting_policy_lines l ${settlement} WHERE l.policy_id=$1 ORDER BY l.position`, [id],
  );
  return { ...header, lines, reconciled: lines.some(({ reconciled }) => reconciled) };
}

export function manualPolicyCommentFields(metadata?: AccountingPolicyCommentMetadata | null) {
  return {
    cheque: metadata?.cheque ?? '', origin: metadata?.origin ?? 'DIARIO', report: metadata?.report ?? '',
    amountInWords: metadata?.amountInWords ?? '', postDate: metadata?.postDate ?? null,
    ...(metadata ? { comments: metadata.comments } : {}),
  };
}

export function manualPolicyProps(policy: ManualPolicyDocument): AccountingPolicyProps {
  const debit = Number(policy.lines.reduce((sum, line) => sum + Math.round(line.debit * 100), 0)) / 100;
  const credit = Number(policy.lines.reduce((sum, line) => sum + Math.round(line.credit * 100), 0)) / 100;
  return {
    id: policy.id, number: policy.number, date: policy.date, concept: policy.concept, beneficiary: policy.beneficiary, family: policy.family,
    ...manualPolicyCommentFields(policy.commentMetadata), company: 1, applied: policy.applied, userId: 0,
    auditAt: policy.updatedAt, classifications: ['', ''], exchangeRate: 1, usedAt: null,
    totals: { debit, credit, difference: Number((debit - credit).toFixed(2)) },
    manual: { revision: policy.revision, canceled: policy.canceled, reconciled: policy.reconciled },
    movements: policy.lines.map((line) => ({ id: line.id, accountId: line.account.id, accountCode: line.account.code,
      accountName: line.account.name, accountType: line.account.type, debit: line.debit, credit: line.credit, reference: line.reference,
      exchangeRate: 1, costCenter: line.costCenter, reconciled: line.reconciled })),
  };
}
