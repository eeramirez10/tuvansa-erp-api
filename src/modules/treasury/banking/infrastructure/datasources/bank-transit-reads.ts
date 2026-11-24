import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import { connectPostgres, postgresConfigured, type PostgresClient } from '../../../../../shared/infrastructure/database/postgres-pool.js';

interface TransitMark {
  movementId: number;
  inTransit: boolean;
  delta: number;
}

async function transitAvailable(client: PostgresClient) {
  const { rows: [row] } = await client.query<{ available: boolean }>(
    "SELECT to_regclass('tuvansa.bank_reconciliation_transit') IS NOT NULL AS available",
  );
  return row?.available === true;
}

export async function readBankTransitOn(client: PostgresClient, companyId: number, bankAccountId: number) {
  if (!await transitAvailable(client)) return [];
  // Derivada. El saldo de apertura de German ya incluye las marcas históricas.
  const { rows } = await client.query<TransitMark>(
    `SELECT movement_id::float8 AS "movementId",in_transit AS "inTransit",
            (CASE WHEN in_transit THEN amount ELSE -amount END)::float8 AS delta
     FROM tuvansa.bank_reconciliation_transit WHERE company_id=$1 AND bank_account_id=$2`,
    [companyId, bankAccountId],
  );
  return rows;
}

export async function readBankTransit(companyId: number, bankAccountId: number) {
  if (!postgresConfigured()) return [];
  let client: PostgresClient | undefined;
  try {
    client = await connectPostgres();
    return await readBankTransitOn(client, companyId, bankAccountId);
  } catch {
    throw new ApplicationError('No fue posible consultar el tránsito de la cuenta.', 'BANK_RECONCILIATION_POSTGRES_UNAVAILABLE', 503);
  } finally {
    client?.release();
  }
}

export async function removeBankTransit(client: PostgresClient, companyId: number, movementIds: number[]) {
  if (!movementIds.length || !await transitAvailable(client)) return;
  await client.query(
    'DELETE FROM tuvansa.bank_reconciliation_transit WHERE company_id=$1 AND movement_id=ANY($2::bigint[])',
    [companyId, movementIds],
  );
}
