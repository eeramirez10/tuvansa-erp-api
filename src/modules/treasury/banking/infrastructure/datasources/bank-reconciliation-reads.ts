import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import { connectPostgres, postgresConfigured, type PostgresClient } from '../../../../../shared/infrastructure/database/postgres-pool.js';

interface BankReconciliationState {
  delta: number;
  lastStatementDate: string | null;
}

const empty: BankReconciliationState = { delta: 0, lastStatementDate: null };

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
