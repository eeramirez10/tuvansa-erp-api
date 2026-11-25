import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import { ConflictError } from '../../../../../shared/domain/errors/conflict-error.js';
import { NotFoundError } from '../../../../../shared/domain/errors/not-found-error.js';
import {
  connectPostgres, postgresConfigured, type PostgresClient, type PostgresConnectionFactory,
} from '../../../../../shared/infrastructure/database/postgres-pool.js';
import { migratePostgres } from '../../../../../shared/infrastructure/datasources/postgres-schema.js';
import { customerCollectionsAvailable } from '../../../../accounts-receivable/clients/infrastructure/datasources/customer-collections-reads.js';
import {
  customerCollectionReversalSql, customerCollectionReversalsAvailable,
} from '../../../../accounts-receivable/clients/infrastructure/datasources/customer-collection-reversal-reads.js';
import type {
  SalesTicketConversionDataSource, SalesTicketConversionResult, SalesTicketConversionSource,
} from '../../domain/datasources/sales-ticket-conversion-data-source.js';
import { isLocalSalesRemissionId, salesRemissionsAvailable } from './postgres-sales-remissions.js';
import { remissionCancellationSql, salesRemissionCancellationsAvailable } from './sales-remission-cancellation-reads.js';
import { salesTicketConversionSql } from './sales-ticket-conversion-reads.js';

// Derivada. El folio web se vincula al origen y no participa en la numeración fiscal de German.
const migrations = [{
  id: 'sales_ticket_conversion',
  sql: `CREATE SEQUENCE tuvansa.sales_ticket_conversion_numbers MAXVALUE 99999999;
    CREATE TABLE tuvansa.sales_ticket_conversions (
      remission_id bigint PRIMARY KEY REFERENCES tuvansa.sales_remissions(id),
      number varchar(15) UNIQUE NOT NULL CHECK (number ~ '^FEW[0-9]{8}$'),
      issued_at date NOT NULL,
      request_key uuid UNIQUE NOT NULL,
      fingerprint char(64) NOT NULL,
      invoice jsonb NOT NULL CHECK (jsonb_typeof(invoice)='object' AND invoice->>'number'=number),
      result jsonb NOT NULL CHECK (jsonb_typeof(result)='object'),
      created_at timestamptz NOT NULL DEFAULT now()
    );`,
}];

const unavailable = () => new ApplicationError(
  'No fue posible consultar o registrar la conversión en PostgreSQL.', 'SALES_TICKET_CONVERSION_STORAGE_UNAVAILABLE', 503,
);

async function readSource(client: PostgresClient, id: number) {
  const conversion = await salesTicketConversionSql(client);
  const cancellation = remissionCancellationSql(await salesRemissionCancellationsAvailable(client));
  const hasCollections = await customerCollectionsAvailable(client);
  const reversal = customerCollectionReversalSql(hasCollections && await customerCollectionReversalsAvailable(client));
  const { rows: [source] } = await client.query<SalesTicketConversionSource>(
    `SELECT remission.result->'invoice' AS invoice, remission.charge::float8 AS charge,
       ${cancellation.canceled} AS canceled, ${conversion.result} AS result,
       ${hasCollections ? 'payments.paid::float8' : '0'} AS paid,
       ${hasCollections ? 'payments.revision' : '1'} AS "paymentRevision"
       FROM tuvansa.sales_remissions remission ${conversion.join} ${cancellation.join}
       ${hasCollections ? `CROSS JOIN LATERAL (
         SELECT coalesce(${reversal.paid},0) AS paid, ${reversal.revision} AS revision
         FROM tuvansa.customer_collections collection ${reversal.join}
         WHERE collection.remission_id=remission.id AND collection.company_id=remission.company_id
           AND collection.client_id=remission.customer_id
       ) payments` : ''}
       WHERE remission.id=$1 AND remission.company_id=1 AND remission.number LIKE 'FAW%'`,
    [id],
  );
  return source ?? null;
}

export class PostgresSalesTicketConversions implements SalesTicketConversionDataSource {
  private migration?: Promise<void>;

  constructor(private readonly connect: PostgresConnectionFactory = connectPostgres, private readonly configured = postgresConfigured) {}

  private async withClient<T>(work: (client: PostgresClient) => Promise<T>): Promise<T> {
    let client: PostgresClient | undefined;
    try {
      client = await this.connect();
      return await work(client);
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      throw unavailable();
    } finally { client?.release(); }
  }

  source(id: number) {
    if (!isLocalSalesRemissionId(id) || !this.configured()) return Promise.resolve(null);
    return this.withClient(async (client) => await salesRemissionsAvailable(client) ? readSource(client, id) : null);
  }

  async convert(id: number, requestKey: string, fingerprint: string, prepare: (source: SalesTicketConversionSource) => Promise<string>) {
    if (!isLocalSalesRemissionId(id)) {
      throw new ApplicationError('La conversión está disponible para remisiones web de México.', 'SALES_TICKET_CONVERSION_INELIGIBLE', 422);
    }
    if (!this.configured()) throw unavailable();
    this.migration ??= this.withClient(async (client) => {
      if (!await salesRemissionsAvailable(client)) throw new NotFoundError('Remisión web');
      await migratePostgres(client, migrations);
    }).catch((error: unknown) => {
      delete this.migration;
      throw error;
    });
    await this.migration;

    return this.withClient(async (client) => {
      await client.query('BEGIN');
      try {
        const result = await this.convertLocked(client, id, requestKey, fingerprint, prepare);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      }
    });
  }

  private async convertLocked(
    client: PostgresClient, id: number, requestKey: string, fingerprint: string,
    prepare: (source: SalesTicketConversionSource) => Promise<string>,
  ) {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('sales-ticket-conversion:' || $1::text,0))", [requestKey]);
    const { rows: [replay] } = await client.query<{ fingerprint: string; result: SalesTicketConversionResult }>(
      'SELECT fingerprint,result FROM tuvansa.sales_ticket_conversions WHERE request_key=$1', [requestKey],
    );
    if (replay) {
      if (replay.fingerprint === fingerprint) return replay.result;
      throw new ConflictError('La solicitud ya se usó para otra conversión.', 'SALES_TICKET_CONVERSION_REQUEST_REUSED');
    }

    // Cobranza, cancelación y simulación coordinan escrituras con el mismo registro.
    await client.query('SELECT id FROM tuvansa.sales_remissions WHERE id=$1 AND company_id=1 FOR UPDATE', [id]);
    const source = await readSource(client, id);
    if (!source) throw new NotFoundError('Remisión web');
    const issuedAt = await prepare(source);
    const { rows: [sequence] } = await client.query<{ folio: string }>(
      "SELECT nextval('tuvansa.sales_ticket_conversion_numbers')::text AS folio",
    );
    const number = 'FEW' + sequence!.folio.padStart(8, '0');
    const { invoice: original } = source;
    const result = { invoiceId: id, sourceNumber: original.number, number, issuedAt };
    const invoice = {
      ...original, number, cfdStatus: '1', deliveryNote: original.number, cancellationAvailable: false,
      dates: { ...original.dates, issuedAt, deliveryNoteAt: original.dates.issuedAt },
    };
    await client.query(
      `INSERT INTO tuvansa.sales_ticket_conversions (remission_id,number,issued_at,request_key,fingerprint,invoice,result)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)`,
      [id, number, issuedAt, requestKey, fingerprint, JSON.stringify(invoice), JSON.stringify(result)],
    );
    return result;
  }
}
