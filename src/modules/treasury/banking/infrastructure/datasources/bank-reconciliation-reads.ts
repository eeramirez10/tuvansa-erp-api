import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import { connectPostgres, postgresConfigured, type PostgresClient } from '../../../../../shared/infrastructure/database/postgres-pool.js';
import type { BankPostdateResult } from '../../domain/datasources/bank-reconciliation-data-source.js';

interface BankReconciliationState {
  delta: number;
  lastStatementDate: string | null;
}

const empty: BankReconciliationState = { delta: 0, lastStatementDate: null };

export async function readBankPostdates(companyId: number, policyIds: number[]) {
  if (!postgresConfigured() || !policyIds.length) return new Map<number, BankPostdateResult>();
  let client: PostgresClient | undefined;
  try {
    client = await connectPostgres();
    const { rows: [table] } = await client.query<{ available: boolean }>(
      "SELECT to_regclass('tuvansa.bank_policy_postdates') IS NOT NULL AS available",
    );
    if (!table?.available) return new Map<number, BankPostdateResult>();
    const { rows } = await client.query<BankPostdateResult>(
      `SELECT policy_id::float8 AS "policyId",revision,post_date::text AS "postDate"
       FROM tuvansa.bank_policy_postdates WHERE company_id=$1 AND policy_id=ANY($2::bigint[])`,
      [companyId, policyIds],
    );
    return new Map(rows.map((row) => [row.policyId, row]));
  } catch {
    throw new ApplicationError('No fue posible consultar la fecha de posfechado.', 'BANK_POSTDATE_POSTGRES_UNAVAILABLE', 503);
  } finally { client?.release(); }
}

export async function readLegacyBankSettlements(accountId: number | null, movementIds: number[] | null = null) {
  if (!postgresConfigured() || movementIds?.length === 0) return [];
  let client: PostgresClient | undefined;
  try {
    client = await connectPostgres();
    if (!await bankReconciliationsAvailable(client)) return [];
    const { rows } = await client.query<{ movementId: number; accountId: number; statementDate: string }>(
      `SELECT m.movement_id::float8 AS "movementId",r.bank_account_id::float8 AS "accountId",r.statement_date::text AS "statementDate"
       FROM tuvansa.bank_reconciliation_movements m JOIN tuvansa.bank_reconciliations r ON r.id=m.reconciliation_id
       WHERE r.company_id=1 AND m.movement_id BETWEEN 1 AND 4294967295
         AND ($1::bigint IS NULL OR r.bank_account_id=$1) AND ($2::bigint[] IS NULL OR m.movement_id=ANY($2))`,
      [accountId, movementIds],
    );
    return rows;
  } catch {
    throw new ApplicationError('No fue posible consultar la conciliación histórica.', 'BANK_RECONCILIATION_POSTGRES_UNAVAILABLE', 503);
  } finally { client?.release(); }
}

export async function bankReconciliationsAvailable(client: PostgresClient): Promise<boolean> {
  const { rows: [row] } = await client.query<{ available: boolean }>(
    `SELECT to_regclass('tuvansa.bank_reconciliations') IS NOT NULL
            AND to_regclass('tuvansa.bank_reconciliation_movements') IS NOT NULL AS available`,
  );
  return row?.available === true;
}

export async function bankReconciliationState(client: PostgresClient, companyId: number, bankAccountId: number): Promise<BankReconciliationState> {
  if (!await bankReconciliationsAvailable(client)) return empty;
  // Derivada. El saldo bancario suma solamente los movimientos registrados en conciliaciones.
  const { rows: [row] } = await client.query<BankReconciliationState>(
    `SELECT coalesce(sum(net_movement), 0)::float8 AS delta, max(statement_date)::text AS "lastStatementDate"
     FROM tuvansa.bank_reconciliations WHERE company_id = $1 AND bank_account_id = $2`,
    [companyId, bankAccountId],
  );
  return row ?? empty;
}

export async function readBankReconciliationState(companyId: number, bankAccountId: number): Promise<BankReconciliationState> {
  if (!postgresConfigured()) return empty;
  let client: PostgresClient | undefined;
  try {
    client = await connectPostgres();
    return await bankReconciliationState(client, companyId, bankAccountId);
  } catch (error) {
    if (error instanceof ApplicationError) throw error;
    throw new ApplicationError('No fue posible consultar la conciliación de la cuenta.', 'BANK_RECONCILIATION_POSTGRES_UNAVAILABLE', 503);
  } finally {
    client?.release();
  }
}

export function joinBankReconciliation(available: boolean, movement = 'posting', settlement = 'settlement', bank = movement): string {
  if (!available) return `CROSS JOIN (SELECT NULL::bigint AS id,NULL::date AS statement_date) AS ${settlement}`;
  const match = `${settlement}_movement`;
  // Derivada. Un movimiento pertenece a un solo registro de conciliación de esa cuenta y empresa.
  return `LEFT JOIN tuvansa.bank_reconciliation_movements AS ${match} ON ${match}.movement_id=${movement}.id
    LEFT JOIN tuvansa.bank_reconciliations AS ${settlement} ON ${settlement}.id=${match}.reconciliation_id
      AND ${settlement}.company_id=${movement}.company_id AND ${settlement}.bank_account_id=${bank}.bank_account_id`;
}
