import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import { ConflictError } from '../../../../../shared/domain/errors/conflict-error.js';
import {
  connectPostgres, postgresConfigured, type PostgresClient, type PostgresConnectionFactory,
} from '../../../../../shared/infrastructure/database/postgres-pool.js';
import { migratePostgres } from '../../../../../shared/infrastructure/datasources/postgres-schema.js';
import type { BankTransferCommand, BankTransferDataSource, BankTransferResult } from '../../domain/datasources/bank-transfer-data-source.js';
import type { BankAccountsWithCatalogDataSource } from './bank-accounts-with-catalog-data-source.js';

const transferIdStart = 7500000000000;
const transferIdEnd = transferIdStart + 99999998;
const movementIdStart = 7600000000000;

export const isLocalBankTransferId = (id: number) => id >= transferIdStart && id <= transferIdEnd;
export const isLocalBankTransferMovementId = (id: number) => id >= movementIdStart && id < movementIdStart + 2 * (transferIdEnd - transferIdStart + 1);

const migrations = [{
  id: 'bank_transfer_capture',
  sql: `
    CREATE SEQUENCE tuvansa.bank_transfer_ids START WITH ${transferIdStart} MAXVALUE ${transferIdEnd};
    CREATE TABLE tuvansa.bank_transfers (
      id bigint PRIMARY KEY,
      company_id integer NOT NULL CHECK (company_id=1),
      user_id integer NOT NULL CHECK (user_id>=0),
      request_key uuid NOT NULL,
      fingerprint char(64) NOT NULL,
      number varchar(10) NOT NULL UNIQUE,
      policy_number varchar(11) NOT NULL UNIQUE,
      movement_type varchar(1) NOT NULL CHECK (movement_type='3'),
      date date NOT NULL,
      amount numeric(18,2) NOT NULL CHECK (amount>0),
      reference varchar(10) NOT NULL,
      beneficiary varchar(85) NOT NULL,
      description varchar(90) NOT NULL,
      result jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(company_id, request_key),
      UNIQUE(id, company_id)
    );
    CREATE TABLE tuvansa.bank_transfer_movements (
      id bigint PRIMARY KEY,
      transfer_id bigint NOT NULL,
      company_id integer NOT NULL,
      bank_account_id bigint NOT NULL,
      bank_code text NOT NULL,
      bank_name text NOT NULL,
      amount numeric(18,2) NOT NULL CHECK (amount<>0),
      FOREIGN KEY(transfer_id,company_id) REFERENCES tuvansa.bank_transfers(id,company_id),
      UNIQUE(transfer_id,bank_account_id)
    );
    CREATE INDEX bank_transfer_movements_account ON tuvansa.bank_transfer_movements(company_id,bank_account_id,id);
  `,
}];

const unavailable = () =>
  new ApplicationError('No fue posible consultar o registrar el traspaso en PostgreSQL.', 'BANK_TRANSFER_POSTGRES_UNAVAILABLE', 503);

export async function bankTransfersAvailable(client: PostgresClient): Promise<boolean> {
  const { rows: [row] } = await client.query<{ available: boolean }>(
    `SELECT to_regclass('tuvansa.bank_transfers') IS NOT NULL
       AND to_regclass('tuvansa.bank_transfer_movements') IS NOT NULL AS available`,
  );
  return row?.available === true;
}

async function withConnection<T>(connect: PostgresConnectionFactory, work: (client: PostgresClient) => Promise<T>): Promise<T> {
  let client: PostgresClient | undefined;
  try {
    client = await connect();
    return await work(client);
  } catch (error) {
    if (error instanceof ApplicationError) throw error;
    throw unavailable();
  } finally {
    client?.release();
  }
}

export function readBankTransfers<T>(fallback: T, read: (client: PostgresClient) => Promise<T>) {
  if (!postgresConfigured()) return Promise.resolve(fallback);
  return withConnection(connectPostgres, async (client) => await bankTransfersAvailable(client) ? read(client) : fallback);
}

export class PostgresBankTransfers implements BankTransferDataSource {
  private migration?: Promise<void>;

  constructor(
    private readonly connect: PostgresConnectionFactory = connectPostgres,
    private readonly configured: () => boolean = postgresConfigured,
    private readonly catalog?: Pick<BankAccountsWithCatalogDataSource, 'lookupOn'>,
  ) {}

  writable() { return this.configured(); }

  private async request(client: PostgresClient, companyId: number, key: string, fingerprint: string) {
    const { rows: [row] } = await client.query<{ result: BankTransferResult; fingerprint: string }>(
      'SELECT result,fingerprint FROM tuvansa.bank_transfers WHERE company_id=$1 AND request_key=$2', [companyId, key],
    );
    if (row && row.fingerprint !== fingerprint) {
      throw new ConflictError('La solicitud de traspaso ya se usó con otros datos.', 'BANK_TRANSFER_REQUEST_CONFLICT');
    }
    return row?.result ?? null;
  }

  findRequest(companyId: number, requestKey: string, fingerprint: string) {
    if (!this.writable()) return Promise.resolve(null);
    return withConnection(this.connect, async (client) =>
      await bankTransfersAvailable(client) ? this.request(client, companyId, requestKey, fingerprint) : null);
  }

  async commit(command: BankTransferCommand): Promise<BankTransferResult> {
    if (!this.writable()) throw unavailable();
    this.migration ??= withConnection(this.connect, (client) => migratePostgres(client, migrations)).catch((error: unknown) => {
      delete this.migration;
      throw error;
    });
    await this.migration;
    return withConnection(this.connect, async (client) => {
      await client.query('BEGIN');
      try {
        const result = await this.saveInTransaction(client, command);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    });
  }

  private async saveInTransaction(
    client: PostgresClient,
    { companyId, userId, destinationAccountId, input, fingerprint, resolvePosting }: BankTransferCommand,
  ) {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('bank-transfer-request:' || $1::text || ':' || $2::text,0))",
      [companyId, input.requestKey]);
    const previous = await this.request(client, companyId, input.requestKey, fingerprint);
    if (previous) return previous;

    const accountIds = [input.sourceBankAccountId, destinationAccountId].sort((first, second) => first - second);
    for (const accountId of accountIds) {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('bank-reconciliation:' || $1::text || ':' || $2::text,0))",
        [companyId, accountId]);
    }
    const { source, destination, settings } = await resolvePosting(this.catalog?.lookupOn(client));
    const { rows: [allocated] } = await client.query<{ id: string }>("SELECT nextval('tuvansa.bank_transfer_ids') AS id");
    const id = Number(allocated!.id);
    const ordinal = id - transferIdStart;
    const sequence = String(ordinal + 1).padStart(8, '0');
    const result = {
      id, number: 'BW' + sequence, policyNumber: settings.policyType + 'BW' + sequence,
      source, destination, sourceMovementId: movementIdStart + ordinal * 2, destinationMovementId: movementIdStart + ordinal * 2 + 1,
      date: input.date, amount: input.amount, reference: input.reference, beneficiary: input.beneficiary, description: input.description,
    };

    await client.query(
      `INSERT INTO tuvansa.bank_transfers
       (id,company_id,user_id,request_key,fingerprint,number,policy_number,movement_type,date,amount,reference,beneficiary,description,result)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb)`,
      [id, companyId, userId, input.requestKey, fingerprint, result.number, result.policyNumber, settings.policyType,
        input.date, input.amount, input.reference, input.beneficiary, input.description, JSON.stringify(result)],
    );
    await client.query(
      `INSERT INTO tuvansa.bank_transfer_movements (id,transfer_id,company_id,bank_account_id,bank_code,bank_name,amount)
       VALUES ($1,$3,$4,$5,$6,$7,-$8::numeric),($2,$3,$4,$9,$10,$11,$8::numeric)`,
      [result.sourceMovementId, result.destinationMovementId, id, companyId, source.id, source.code, source.name, input.amount,
        destination.id, destination.code, destination.name],
    );
    return result;
  }
}
