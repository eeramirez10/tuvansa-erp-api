import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import { ConflictError } from '../../../../../shared/domain/errors/conflict-error.js';
import { NotFoundError } from '../../../../../shared/domain/errors/not-found-error.js';
import { connectPostgres, postgresConfigured, type PostgresClient, type PostgresConnectionFactory } from '../../../../../shared/infrastructure/database/postgres-pool.js';
import { migratePostgres } from '../../../../../shared/infrastructure/datasources/postgres-schema.js';
import { bankReconciliationState, bankReconciliationsAvailable, joinBankReconciliation } from '../../../../treasury/banking/infrastructure/datasources/bank-reconciliation-reads.js';
import type {
  CustomerCollectionReversalCommand, CustomerCollectionReversalDataSource, CustomerCollectionReversalIdentity,
  CustomerCollectionReversalResult, CustomerCollectionReversalSource,
} from '../../domain/datasources/customer-collection-reversal-data-source.js';
import { customerCollectionReversalIdEnd, customerCollectionReversalIdStart, customerCollectionReversalSql, customerCollectionReversalsAvailable } from './customer-collection-reversal-reads.js';
import { customerCollectionsAvailable, remissionCollectionStatus } from './customer-collections-reads.js';
import { isLocalCustomerCollectionId } from './postgres-customer-collections.js';

const migrations = [{ id: 'customer_collection_reversal', sql: `
  CREATE SEQUENCE tuvansa.customer_collection_reversal_ids START WITH ${customerCollectionReversalIdStart} MAXVALUE ${customerCollectionReversalIdEnd};
  CREATE TABLE tuvansa.customer_collection_reversals (
    id bigint PRIMARY KEY,
    collection_id bigint NOT NULL UNIQUE REFERENCES tuvansa.customer_collections(id),
    company_id integer NOT NULL CHECK (company_id=1),
    user_id integer NOT NULL CHECK (user_id>=0),
    request_key uuid NOT NULL,
    fingerprint char(64) NOT NULL,
    date date NOT NULL,
    number varchar(15) NOT NULL UNIQUE,
    policy_number varchar(11) NOT NULL UNIQUE,
    reason varchar(90) NOT NULL CHECK (length(trim(reason))>0),
    result jsonb NOT NULL CHECK (jsonb_typeof(result)='object'),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(company_id,request_key)
  );
` }];

const unavailable = () => new ApplicationError('No fue posible consultar o revertir el cobro en PostgreSQL.', 'CUSTOMER_COLLECTION_REVERSAL_POSTGRES_UNAVAILABLE', 503);

async function original(client: PostgresClient, { companyId, clientId, collectionId }: CustomerCollectionReversalIdentity) {
  if (companyId !== 1 || !isLocalCustomerCollectionId(collectionId) || !await customerCollectionsAvailable(client)) return null;
  const reversal = customerCollectionReversalSql(await customerCollectionReversalsAvailable(client));
  const reconciliation = joinBankReconciliation(await bankReconciliationsAvailable(client), 'collection');
  const { rows: [row] } = await client.query<Omit<CustomerCollectionReversalSource, 'latestBankStatementDate' | 'lastCollectionReversalAt'>>(
    `SELECT collection.number,collection.policy_number AS "policyNumber",collection.date::text AS "originalDate",
       collection.amount::float8,collection.bank_account_id::float8 AS "bankAccountId",remission.id::float8 AS "remissionId",
       coalesce(nullif(collection.result->>'remissionNumber',''),remission.number) AS "remissionNumber",
       remission.charge::float8 AS principal,
       (collection.amount>0 AND collection.movement_type='PA' AND collection.policy_number LIKE '1CW%'
        AND remission.number LIKE 'FAW%' AND remission.result #>> '{invoice,currency,id}'='1'
        AND (remission.result #>> '{invoice,currency,exchangeRate}')::numeric=1
        AND collection.bank_code<>collection.client_account) AS supported,
       CASE WHEN settlement.id IS NOT NULL THEN jsonb_build_object('id',settlement.id,'date',settlement.statement_date) END AS "originalReconciliation",
       ${reversal.result} AS "alreadyRecorded"
     FROM tuvansa.customer_collections collection ${reversal.join} ${reconciliation}
     JOIN tuvansa.sales_remissions remission ON remission.id=collection.remission_id AND remission.company_id=collection.company_id
       AND remission.customer_id=collection.client_id
     WHERE collection.company_id=$1 AND collection.client_id=$2 AND collection.id=$3`, [companyId, clientId, collectionId],
  );
  if (!row) return null;
  const { lastCollectionReversalAt } = await remissionCollectionStatus(client, { companyId, customerId: clientId, id: row.remissionId });
  const latestBankStatementDate = row.originalReconciliation
    ? (await bankReconciliationState(client, companyId, row.bankAccountId)).lastStatementDate : null;
  return { ...row, latestBankStatementDate, lastCollectionReversalAt };
}

async function priorRequest(client: PostgresClient, companyId: number, requestKey: string, fingerprint: string) {
  const { rows: [row] } = await client.query<{ fingerprint: string; result: CustomerCollectionReversalResult }>(
    'SELECT fingerprint,result FROM tuvansa.customer_collection_reversals WHERE company_id=$1 AND request_key=$2', [companyId, requestKey],
  );
  if (row && row.fingerprint !== fingerprint) throw new ConflictError('La solicitud ya se usó con otros datos.', 'CUSTOMER_COLLECTION_REVERSAL_REQUEST_CONFLICT');
  return row?.result ?? null;
}

export class PostgresCustomerCollectionReversals implements CustomerCollectionReversalDataSource {
  private migration?: Promise<void>;

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

  source(identity: CustomerCollectionReversalIdentity) { return this.withConnection((client) => original(client, identity)); }

  findRequest(companyId: number, requestKey: string, fingerprint: string) {
    return this.withConnection(async (client) => await customerCollectionReversalsAvailable(client)
      ? priorRequest(client, companyId, requestKey, fingerprint) : null);
  }

  async commit({ identity, userId, input, fingerprint, validate }: CustomerCollectionReversalCommand) {
    this.migration ??= this.withConnection((client) => migratePostgres(client, migrations)).catch((error: unknown) => {
      delete this.migration;
      throw error;
    });
    await this.migration;
    const { companyId, clientId, collectionId } = identity;
    return this.withConnection(async (client) => {
      await client.query('BEGIN');
      try {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended('customer-collection-reversal:'||$1::text||':'||$2::text,0))", [companyId, input.requestKey]);
        const previous = await priorRequest(client, companyId, input.requestKey, fingerprint);
        if (previous) {
          await client.query('COMMIT');
          return previous;
        }
        // FAW y Cobranza comprueban el saldo bajo el bloqueo de crédito antes del documento.
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended('sales-credit:'||$1::text||':'||$2::text,0))", [companyId, clientId]);
        const before = await original(client, identity);
        if (!before) throw new NotFoundError('Cobro PA registrado en la web');
        await client.query('SELECT id FROM tuvansa.sales_remissions WHERE id=$1 AND company_id=$2 AND customer_id=$3 FOR UPDATE',
          [before.remissionId, companyId, clientId]);
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended('bank-reconciliation:'||$1::text||':'||$2::text,0))", [companyId, before.bankAccountId]);
        const current = await original(client, identity);
        if (!current) throw new NotFoundError('Cobro PA registrado en la web');
        validate(current);

        const { rows: [allocation] } = await client.query<{ id: string }>("SELECT nextval('tuvansa.customer_collection_reversal_ids') AS id");
        const id = Number(allocation!.id);
        const suffix = String(id - customerCollectionReversalIdStart + 1).padStart(8, '0');
        const result: CustomerCollectionReversalResult = { id, policyNumber: `1CV${suffix}`, date: input.date, reason: input.reason,
          ...(current.originalReconciliation ? { originalReconciliation: current.originalReconciliation } : {}) };
        await client.query(
          `INSERT INTO tuvansa.customer_collection_reversals
           (id,collection_id,company_id,user_id,request_key,fingerprint,date,number,policy_number,reason,result)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)`,
          [id, collectionId, companyId, userId, input.requestKey, fingerprint, input.date, `RPA${suffix}`, result.policyNumber, input.reason, JSON.stringify(result)],
        );
        await removeBankTransit(client, companyId, [collectionId]);
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
