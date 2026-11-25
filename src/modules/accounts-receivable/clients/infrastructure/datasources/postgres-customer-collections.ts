import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import { ConflictError } from '../../../../../shared/domain/errors/conflict-error.js';
import { NotFoundError } from '../../../../../shared/domain/errors/not-found-error.js';
import {
  connectPostgres, postgresConfigured, type PostgresClient, type PostgresConnectionFactory,
} from '../../../../../shared/infrastructure/database/postgres-pool.js';
import { migratePostgres } from '../../../../../shared/infrastructure/datasources/postgres-schema.js';
import {
  isLocalSalesRemissionId, salesRemissionsAvailable,
} from '../../../../sales/invoicing/infrastructure/datasources/postgres-sales-remissions.js';
import type { BankAccountsWithCatalogDataSource } from '../../../../treasury/banking/infrastructure/datasources/bank-accounts-with-catalog-data-source.js';
import type {
  CustomerCollectionCommand, CustomerCollectionDataSource, CustomerCollectionIdentity,
  CustomerCollectionResult, CustomerCollectionTarget,
} from '../../domain/datasources/customer-collection-data-source.js';
import { validateCustomerCollection } from '../../domain/entities/customer-collection.js';
import { customerCollectionsAvailable } from './customer-collections-reads.js';
import { customerCollectionReversalSql, customerCollectionReversalsAvailable } from './customer-collection-reversal-reads.js';
import { clientCatalogRecord } from './postgres-client-catalog.js';
import { remissionCancellationSql, salesRemissionCancellationsAvailable } from '../../../../sales/invoicing/infrastructure/datasources/sales-remission-cancellation-reads.js';

const idStart = 7300000000000;
const idEnd = idStart + 99999998;
export const isLocalCustomerCollectionId = (id: number) => id >= idStart && id <= idEnd;

// Derivada. Una fila representa el abono, el depósito y la póliza de ingresos.
const migrations = [{
  id: 'customer_collection_capture',
  sql: `
    CREATE SEQUENCE tuvansa.customer_collection_ids START WITH ${idStart} MAXVALUE ${idEnd};
    CREATE TABLE tuvansa.customer_collections (
      id bigint PRIMARY KEY,
      company_id integer NOT NULL,
      user_id integer NOT NULL CHECK (user_id >= 0),
      request_key uuid NOT NULL,
      fingerprint char(64) NOT NULL,
      client_id bigint NOT NULL,
      remission_id bigint NOT NULL REFERENCES tuvansa.sales_remissions(id),
      remission_revision integer NOT NULL CHECK (remission_revision > 1),
      bank_account_id bigint NOT NULL,
      bank_code text NOT NULL,
      bank_name text NOT NULL,
      client_account text NOT NULL,
      client_account_name text NOT NULL,
      amount numeric(18,2) NOT NULL CHECK (amount > 0),
      date date NOT NULL,
      movement_type varchar(2) NOT NULL CHECK (movement_type = 'PA'),
      number varchar(11) NOT NULL UNIQUE,
      receipt_number integer NOT NULL UNIQUE,
      policy_number varchar(11) NOT NULL UNIQUE,
      description varchar(90) NOT NULL,
      reference varchar(45) NOT NULL,
      result jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (company_id, request_key),
      UNIQUE (remission_id, remission_revision),
      CHECK (bank_code <> client_account)
    );
    CREATE INDEX customer_collections_ledger ON tuvansa.customer_collections(company_id,client_id,date,id);
    CREATE INDEX customer_collections_bank ON tuvansa.customer_collections(company_id,bank_account_id,date,id);
  `,
}];

const unavailable = () => new ApplicationError(
  'No fue posible consultar o registrar la cobranza en PostgreSQL.', 'CUSTOMER_COLLECTION_POSTGRES_UNAVAILABLE', 503,
);

async function withConnection<T>(
  connect: PostgresConnectionFactory, read: (client: PostgresClient) => Promise<T>,
): Promise<T> {
  let client: PostgresClient | undefined;
  try {
    client = await connect();
    return await read(client);
  } catch (error) {
    if (error instanceof ApplicationError) throw error;
    throw unavailable();
  } finally {
    client?.release();
  }
}

export function readCustomerCollections<T>(fallback: T, read: (client: PostgresClient) => Promise<T>) {
  if (!postgresConfigured()) return Promise.resolve(fallback);
  return withConnection(connectPostgres, async (client) =>
    await customerCollectionsAvailable(client) ? read(client) : fallback);
}

export class PostgresCustomerCollections implements CustomerCollectionDataSource {
  private migration?: Promise<void>;

  constructor(
    private readonly connect: PostgresConnectionFactory = connectPostgres,
    private readonly configured = postgresConfigured,
    private readonly bankCatalog?: Pick<BankAccountsWithCatalogDataSource, 'lookupOn'>,
  ) {}

  writable() { return this.configured(); }

  private async findTarget(client: PostgresClient, identity: CustomerCollectionIdentity, hasCollections: boolean) {
    const cancellation = remissionCancellationSql(await salesRemissionCancellationsAvailable(client), 'r');
    const reversal = customerCollectionReversalSql(hasCollections && await customerCollectionReversalsAvailable(client));
    const { rows: [row] } = await client.query<CustomerCollectionTarget>(
      `SELECT r.id::float8 AS "remissionId", r.number, r.issued_at::text AS "issuedAt",
         r.result #>> '{invoice,movementType}' AS "movementType",
         (${cancellation.canceled} OR coalesce((r.result #>> '{invoice,canceled}')::boolean, false)) AS canceled,
         r.charge::float8 AS principal,
         (r.result #>> '{invoice,currency,id}')::integer AS "currencyId",
         (r.result #>> '{invoice,currency,exchangeRate}')::float8 AS "exchangeRate",
         (CASE WHEN ${cancellation.canceled} THEN 0 ELSE ${hasCollections ? 'greatest(r.charge - payments.paid,0)' : 'r.charge'} END)::float8 AS remaining,
         ${hasCollections ? 'payments.revision' : '1'} AS revision,
         ${hasCollections ? 'payments."lastReversalDate"' : 'null::text'} AS "lastReversalDate"
       FROM tuvansa.sales_remissions r ${cancellation.join}
       ${hasCollections ? `CROSS JOIN LATERAL (
          SELECT coalesce(${reversal.paid},0) AS paid,${reversal.revision} AS revision,${reversal.latestDate} AS "lastReversalDate"
          FROM tuvansa.customer_collections collection ${reversal.join}
          WHERE collection.remission_id=r.id AND collection.company_id=r.company_id AND collection.client_id=r.customer_id
         ) AS payments` : ''}
       WHERE r.id = $1 AND r.company_id = $2 AND r.customer_id = $3 AND r.number LIKE 'FAW%'`,
      [identity.remissionId, identity.companyId, identity.clientId],
    );
    return row ?? null;
  }

  target(identity: CustomerCollectionIdentity) {
    if (!this.writable() || !isLocalSalesRemissionId(identity.remissionId)) return Promise.resolve(null);
    return withConnection(this.connect, async (client) => {
      if (!await salesRemissionsAvailable(client)) return null;
      return this.findTarget(client, identity, await customerCollectionsAvailable(client));
    });
  }

  private async request(client: PostgresClient, companyId: number, requestKey: string, fingerprint: string) {
    const { rows: [row] } = await client.query<{ result: CustomerCollectionResult; fingerprint: string }>(
      'SELECT result, fingerprint FROM tuvansa.customer_collections WHERE company_id = $1 AND request_key = $2',
      [companyId, requestKey],
    );
    if (row && row.fingerprint !== fingerprint) {
      throw new ConflictError('La solicitud de cobro ya se usó con otros datos.', 'CUSTOMER_COLLECTION_REQUEST_CONFLICT');
    }
    return row?.result ?? null;
  }

  findRequest(companyId: number, requestKey: string, fingerprint: string) {
    if (!this.writable()) return Promise.resolve(null);
    return withConnection(this.connect, async (client) =>
      await customerCollectionsAvailable(client) ? this.request(client, companyId, requestKey, fingerprint) : null);
  }

  async commit(command: CustomerCollectionCommand) {
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
    client: PostgresClient, { identity, userId, input, fingerprint, resolvePosting }: CustomerCollectionCommand,
  ) {
    const { companyId, clientId, remissionId } = identity;
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('customer-collection:' || $1::text || ':' || $2::text,0))",
      [companyId, input.requestKey],
    );
    const existing = await this.request(client, companyId, input.requestKey, fingerprint);
    if (existing) return existing;

    // Serialize the collection against other collections and new remissions for the same customer.
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('sales-credit:' || $1 || ':' || $2,0))",
      [String(companyId), String(clientId)],
    );
    await client.query(
      'SELECT id FROM tuvansa.sales_remissions WHERE id = $1 AND company_id = $2 AND customer_id = $3 FOR UPDATE',
      [remissionId, companyId, clientId],
    );
    const target = await this.findTarget(client, identity, true);
    if (!target) throw new NotFoundError('Remisión web del cliente');
    validateCustomerCollection(target, input);
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('bank-reconciliation:'||$1::text||':'||$2::text,0))", [companyId, input.bankAccountId]);
    const catalog = await clientCatalogRecord(clientId, client);
    const { bank, clientAccount, clientAccountName, policyType } = await resolvePosting(this.bankCatalog?.lookupOn(client), catalog);

    const { rows: [allocation] } = await client.query<{ id: string }>("SELECT nextval('tuvansa.customer_collection_ids') AS id");
    const id = Number(allocation!.id);
    const receiptNumber = id - idStart + 1;
    const suffix = String(receiptNumber).padStart(8, '0');
    const number = 'PAW' + suffix;
    const policyNumber = policyType + 'CW' + suffix;
    const result: CustomerCollectionResult = {
      id, remissionId, remissionNumber: target.number, number, receiptNumber, bankAccountId: bank.id,
      amount: input.amount, date: input.date, policyNumber, remaining: Number((target.remaining - input.amount).toFixed(2)),
    };
    await client.query(
      `INSERT INTO tuvansa.customer_collections
       (id, company_id, user_id, request_key, fingerprint, client_id, remission_id, remission_revision,
        bank_account_id, bank_code, bank_name, client_account, client_account_name, amount, date,
        movement_type, number, receipt_number, policy_number, description, reference, result)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'PA',$16,$17,$18,$19,$20,$21::jsonb)`,
      [id, companyId, userId, input.requestKey, fingerprint, clientId, remissionId, target.revision + 1,
        bank.id, bank.code, bank.name, clientAccount, clientAccountName, input.amount, input.date,
        number, receiptNumber, policyNumber, input.description || 'Cobranza ' + target.number, input.reference, JSON.stringify(result)],
    );
    return result;
  }
}
