import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import { ConflictError } from '../../../../../shared/domain/errors/conflict-error.js';
import { connectPostgres, postgresConfigured, postgresUnavailable,
  type PostgresClient, type PostgresConnectionFactory } from '../../../../../shared/infrastructure/database/postgres-pool.js';
import { migratePostgres } from '../../../../../shared/infrastructure/datasources/postgres-schema.js';
import { invoicePieceVersion, type InvoicePieceEdit, type InvoicePieceIdentity,
  type InvoicePieceStore, type SavedInvoicePiece } from '../../application/use-cases/edit-invoice-pieces.js';
import { isLocalSalesRemissionId, localSalesRemissionNumber } from './postgres-sales-remissions.js';
import { invoiceTransfersOn, lockInvoiceTransfer } from './invoice-transfer-reads.js';

// Derivada. El historial conserva el vínculo DSEQ/DNUM/AISEQ y permite recuperar un intento confirmado.
const migrations = [{
  id: 'sales_invoice_line_pieces',
  sql: `CREATE TABLE tuvansa.sales_invoice_line_pieces (
    invoice_id bigint NOT NULL,
    invoice_number text NOT NULL,
    line_id bigint NOT NULL,
    revision integer NOT NULL CHECK (revision > 0),
    value varchar(24000) NOT NULL,
    expected_version text NOT NULL,
    request_key uuid NOT NULL,
    saved_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (invoice_id, invoice_number, line_id, revision),
    UNIQUE (invoice_id, invoice_number, line_id, request_key)
  );`,
}];

const fields = 'line_id::float8 AS "lineId", value, revision, expected_version AS "expectedVersion"';
const lineScope = 'invoice_id=$1 AND invoice_number=$2 AND line_id=$3';
const table = 'tuvansa.sales_invoice_line_pieces';
const storageNumber = ({ id, number }: InvoicePieceIdentity) =>
  isLocalSalesRemissionId(id) ? localSalesRemissionNumber(id) : number;

export async function invoiceHasPieceEditsOn(client: PostgresClient, invoiceId: number) {
  const { rows: [schema] } = await client.query<{ present: boolean }>(`SELECT to_regclass('${table}') IS NOT NULL AS present`);
  if (!schema?.present) return false;
  const { rows: [row] } = await client.query<{ present: boolean }>(
    `SELECT EXISTS(SELECT 1 FROM ${table} WHERE invoice_id=$1) AS present`, [invoiceId],
  );
  return row?.present === true;
}

export class PostgresInvoicePieces implements InvoicePieceStore {
  private migration?: Promise<void>;

  constructor(private readonly connect: PostgresConnectionFactory = connectPostgres, private readonly configured = postgresConfigured) {}

  writable() { return this.configured(); }

  private async withClient<T>(work: (client: PostgresClient) => Promise<T>): Promise<T> {
    let client: PostgresClient | undefined;
    try {
      client = await this.connect();
      return await work(client);
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      throw new ApplicationError('No fue posible consultar o guardar el valor de piezas.', 'INVOICE_PIECES_UNAVAILABLE', 503);
    } finally { client?.release(); }
  }

  async latest(invoice: InvoicePieceIdentity) {
    if (!this.writable()) return [];
    return this.withClient(async (client) => {
      const { rows: [schema] } = await client.query<{ present: boolean }>(`SELECT to_regclass('${table}') IS NOT NULL AS present`);
      if (!schema?.present) return [];
      const { rows } = await client.query<SavedInvoicePiece>(
        `SELECT DISTINCT ON (line_id) ${fields} FROM ${table}
          WHERE invoice_id=$1 AND invoice_number=$2 ORDER BY line_id, revision DESC`,
        [invoice.id, storageNumber(invoice)],
      );
      return rows;
    });
  }

  async save(invoice: InvoicePieceIdentity, lineId: number, original: string, edit: InvoicePieceEdit) {
    if (!this.writable()) throw postgresUnavailable();
    this.migration ??= this.withClient((client) => migratePostgres(client, migrations)).catch((error: unknown) => {
      delete this.migration;
      throw error;
    });
    await this.migration;
    return this.withClient(async (client) => {
      await client.query('BEGIN');
      try {
        const saved = await this.saveLocked(client, invoice, lineId, original, edit);
        await client.query('COMMIT');
        return saved;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    });
  }

  private async saveLocked(client: PostgresClient, invoice: InvoicePieceIdentity, lineId: number, original: string, edit: InvoicePieceEdit) {
    const scope = [invoice.id, storageNumber(invoice), lineId];
    await lockInvoiceTransfer(client, invoice.id);
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('sales-invoice-pieces:' || $1::text || ':' || $2::text,0))", [invoice.id, lineId]);
    const { rows: [replay] } = await client.query<SavedInvoicePiece>(
      `SELECT ${fields} FROM ${table} WHERE ${lineScope} AND request_key=$4`, [...scope, edit.requestKey],
    );
    if (replay) {
      if (replay.expectedVersion === edit.expectedVersion && replay.value === edit.value) return replay;
      throw new ConflictError('La clave del guardado ya se usó para otro valor.', 'INVOICE_PIECES_REQUEST_REUSED');
    }
    if ((await invoiceTransfersOn(client, { invoiceIds: [invoice.id] })).length) {
      throw new ConflictError('La remisión ya se traspasó.', 'INVOICE_ALREADY_TRANSFERRED');
    }

    const { rows: [latest] } = await client.query<{ revision: number }>(
      `SELECT revision FROM ${table} WHERE ${lineScope} ORDER BY revision DESC LIMIT 1`, scope,
    );
    const revision = latest?.revision ?? 0;
    if (invoicePieceVersion(invoice, lineId, original, revision) !== edit.expectedVersion) {
      throw new ConflictError('El valor de piezas cambió. Vuelve a abrir la ventana.', 'INVOICE_PIECES_STALE');
    }
    const { rows: [saved] } = await client.query<SavedInvoicePiece>(
      `INSERT INTO ${table}(invoice_id,invoice_number,line_id,revision,value,expected_version,request_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING ${fields}`,
      [...scope, revision + 1, edit.value, edit.expectedVersion, edit.requestKey],
    );
    return saved!;
  }
}
