import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import { ConflictError } from '../../../../../shared/domain/errors/conflict-error.js';
import { connectPostgres, postgresConfigured, postgresUnavailable, type PostgresClient } from '../../../../../shared/infrastructure/database/postgres-pool.js';
import { migratePostgres } from '../../../../../shared/infrastructure/datasources/postgres-schema.js';
import type { SupplierCatalogReadSession, SupplierCatalogStorage, SupplierCatalogWriteSession } from '../../domain/datasources/supplier-catalog-data-source.js';
import type { SupplierCatalogRecord } from '../../domain/entities/supplier-catalog.js';

const firstId = 1500000000;
const lastId = firstId + 99999999;
export const isLocalSupplierCatalogId = (id: number) => id >= firstId && id <= lastId;

const migrations = [{ id: 'supplier_catalog', sql: `
  CREATE SEQUENCE tuvansa.supplier_catalog_ids START WITH ${firstId} MAXVALUE ${lastId};
  CREATE TABLE tuvansa.supplier_catalog (
    id bigint PRIMARY KEY,
    legacy boolean NOT NULL,
    original_code varchar(6),
    code varchar(6) NOT NULL,
    supplier jsonb NOT NULL CHECK (jsonb_typeof(supplier)='object'),
    parameters jsonb NOT NULL CHECK (jsonb_typeof(parameters)='object'),
    revision integer NOT NULL CHECK (revision>0),
    create_key uuid UNIQUE,
    create_fingerprint char(64),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz,
    CHECK ((supplier->>'id')::bigint=id AND supplier->>'code'=code),
    CHECK ((legacy AND original_code IS NOT NULL) OR (NOT legacy AND create_key IS NOT NULL AND create_fingerprint IS NOT NULL))
  );
  CREATE UNIQUE INDEX supplier_catalog_code ON tuvansa.supplier_catalog(lower(code));
` }];

const columns = `id::float8 AS id,supplier,legacy,original_code AS "originalCode",revision,deleted_at IS NOT NULL AS deleted,
  (parameters->>'tolerancePercent')::float8 AS "tolerancePercent",(parameters->>'vatCode')::float8 AS "vatCode",
  (parameters->>'withheldVat')::float8 AS "withheldVat",(parameters->>'withheldIncomeTax')::float8 AS "withheldIncomeTax",
  (parameters->>'intercompany')::float8 AS intercompany`;
const failed = () => new ApplicationError('No fue posible consultar o guardar proveedores en PostgreSQL.', 'SUPPLIER_CATALOG_POSTGRES_UNAVAILABLE', 503);

async function available(client: PostgresClient) {
  const { rows: [result] } = await client.query<{ ready: boolean }>("SELECT to_regclass('tuvansa.supplier_catalog') IS NOT NULL AS ready");
  return result?.ready === true;
}

export async function lockSupplierCatalog(client: PostgresClient, id: number): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('supplier-catalog:' || $1::text,0))", [id]);
}

async function connection<T>(work: (client: PostgresClient) => Promise<T>): Promise<T> {
  let client: PostgresClient | undefined;
  try {
    client = await connectPostgres();
    return await work(client);
  } catch (error) {
    if (error instanceof ApplicationError) throw error;
    throw failed();
  } finally { client?.release(); }
}

async function recordsOn(client: PostgresClient, ids: number[]): Promise<Map<number, SupplierCatalogRecord>> {
  if (!ids.length || !await available(client)) return new Map();
  const { rows } = await client.query<SupplierCatalogRecord>(
    `SELECT ${columns} FROM tuvansa.supplier_catalog WHERE id=ANY($1::bigint[])`, [ids],
  );
  return new Map(rows.map((row) => [row.supplier.id, row]));
}

export function supplierCatalogRecordsById(ids: number[], client?: PostgresClient): Promise<Map<number, SupplierCatalogRecord>> {
  if (client) return recordsOn(client, ids);
  return ids.length && postgresConfigured() ? connection((client) => recordsOn(client, ids)) : Promise.resolve(new Map());
}

export async function supplierCatalogRecord(id: number, client?: PostgresClient): Promise<SupplierCatalogRecord | null> {
  return (await supplierCatalogRecordsById([id], client)).get(id) ?? null;
}

export async function assertActiveSupplierCatalog(client: PostgresClient, id: number): Promise<void> {
  await lockSupplierCatalog(client, id);
  const record = await supplierCatalogRecord(id, client);
  if (record?.deleted || (isLocalSupplierCatalogId(id) && !record?.supplier.isActive)) {
    throw new ConflictError('El proveedor ya no está disponible en el catálogo.', 'SUPPLIER_CATALOG_UNAVAILABLE');
  }
}

export function searchSupplierCatalogRecords(query: string, exact: boolean): Promise<SupplierCatalogRecord[]> {
  if (!postgresConfigured()) return Promise.resolve([]);
  return connection(async (client) => {
    if (!await available(client)) return [];
    const { rows } = await client.query<SupplierCatalogRecord>(
      `SELECT ${columns} FROM tuvansa.supplier_catalog
       WHERE CASE WHEN $2::boolean THEN lower(code)=lower($1) OR lower(original_code)=lower($1)
         ELSE strpos(lower(code),lower($1))>0 OR strpos(lower(original_code),lower($1))>0
           OR strpos(lower(supplier->>'name'),lower($1))>0 END
       ORDER BY lower(code),id`, [query.trim(), exact],
    );
    return rows;
  });
}

const dependencies = [
  ['purchase_receptions', "dep.result#>>'{reception,supplier,id}'=target.id::text", 'El proveedor tiene recepciones de compra registradas.'],
  ['purchase_expense_documents', 'dep.supplier_id=target.id', 'El proveedor tiene gastos GA registrados.'],
  ['purchase_reception_documentations', 'dep.supplier_id=target.id', 'El proveedor tiene recepciones documentadas.'],
  ['supplier_payments', 'dep.supplier_id=target.id', 'El proveedor tiene pagos PP registrados.'],
  ['purchase_orders', "dep.header#>>'{supplier,id}'=target.id::text", 'El proveedor tiene órdenes o cotizaciones web.'],
  ['purchase_order_supplier_changes', "dep.previous_supplier_id=target.id OR dep.supplier->>'id'=target.id::text", 'El proveedor aparece en el historial de órdenes.'],
  ['supplier_catalog', "dep.id<>target.id AND dep.deleted_at IS NULL AND target.code<>'' AND lower(dep.supplier#>>'{terms,applyToSupplierCode}')=lower(target.code)", 'Otro proveedor aplica movimientos a este código.'],
] as const;

async function dependency(client: PostgresClient, id: number, code: string): Promise<string | null> {
  const { rows } = await client.query<{ table_name: string }>(
    "SELECT table_name FROM information_schema.tables WHERE table_schema='tuvansa' AND table_name=ANY($1::text[])",
    [dependencies.map(([table]) => table)],
  );
  const existing = new Set(rows.map(({ table_name }) => table_name));
  const eligible = dependencies.map(([table, condition], index) => ({ table, condition, index })).filter(({ table }) => existing.has(table));
  if (!eligible.length) return null;
  const { rows: [result] } = await client.query<{ ordinal: number }>(
    `WITH target AS (SELECT $1::bigint AS id,$2::text AS code)
     SELECT ordinal FROM (${eligible.map(({ table, condition, index }) =>
      `SELECT ${index} AS ordinal WHERE EXISTS(SELECT 1 FROM tuvansa.${table} dep CROSS JOIN target WHERE ${condition})`,
    ).join(' UNION ALL ')}) AS found ORDER BY ordinal LIMIT 1`, [id, code],
  );
  return result ? dependencies[result.ordinal]?.[2] ?? null : null;
}

function session(client: PostgresClient): SupplierCatalogWriteSession {
  return {
    findById: (id) => supplierCatalogRecord(id, client),
    dependency: (id, code) => dependency(client, id, code),
    lockSupplier: (id) => lockSupplierCatalog(client, id),
    async newId() {
      const { rows: [row] } = await client.query<{ id: string }>("SELECT nextval('tuvansa.supplier_catalog_ids') AS id");
      return Number(row!.id);
    },
    async findByCode(code) {
      const { rows: [row] } = await client.query<SupplierCatalogRecord>(
        `SELECT ${columns} FROM tuvansa.supplier_catalog WHERE lower(code)=lower($1)`, [code],
      );
      return row ?? null;
    },
    async findByRequest(key, fingerprint) {
      const { rows: [row] } = await client.query<SupplierCatalogRecord & { fingerprint: string }>(
        `SELECT ${columns},create_fingerprint AS fingerprint FROM tuvansa.supplier_catalog WHERE create_key=$1`, [key],
      );
      if (row && row.fingerprint !== fingerprint) throw new ConflictError('La solicitud de alta ya se usó con otros datos.', 'SUPPLIER_CATALOG_REQUEST_CONFLICT');
      return row ?? null;
    },
    async save({ supplier, legacy, deleted, revision, originalCode, ...parameters }, request) {
      const supplierJson = JSON.stringify(supplier);
      const parametersJson = JSON.stringify(parameters);
      if (revision > 1) {
        await client.query(
          `UPDATE tuvansa.supplier_catalog SET code=$2,supplier=$3::jsonb,parameters=$4::jsonb,
             revision=$5,deleted_at=CASE WHEN $6::boolean THEN now() END,updated_at=now() WHERE id=$1`,
          [supplier.id, supplier.code, supplierJson, parametersJson, revision, deleted],
        );
        return;
      }
      await client.query(
        `INSERT INTO tuvansa.supplier_catalog (id,legacy,original_code,code,supplier,parameters,revision,create_key,create_fingerprint,deleted_at)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,$9,CASE WHEN $10::boolean THEN now() END)`,
        [supplier.id, legacy, originalCode, supplier.code, supplierJson, parametersJson, revision,
          request?.key ?? null, request?.fingerprint ?? null, deleted],
      );
    },
  };
}

export class PostgresSupplierCatalogDataSource implements SupplierCatalogStorage {
  private prepared?: Promise<void>;

  writable() { return postgresConfigured(); }

  read<T>(fallback: T, operation: (session: SupplierCatalogReadSession) => Promise<T>): Promise<T> {
    return this.writable() ? connection((client) => operation(session(client))) : Promise.resolve(fallback);
  }

  list(): Promise<SupplierCatalogRecord[]> {
    return this.writable() ? connection(async (client) => (await available(client)
      ? (await client.query<SupplierCatalogRecord>(`SELECT ${columns} FROM tuvansa.supplier_catalog ORDER BY lower(code),id`)).rows : [])) : Promise.resolve([]);
  }

  async write<T>(operation: (session: SupplierCatalogWriteSession) => Promise<T>): Promise<T> {
    if (!this.writable()) throw postgresUnavailable();
    this.prepared ??= connection((client) => migratePostgres(client, migrations)).catch((error: unknown) => {
      delete this.prepared;
      throw error;
    });
    await this.prepared;
    return connection(async (client) => {
      await client.query('BEGIN');
      try {
        await client.query('SELECT pg_advisory_xact_lock(715003)');
        const result = await operation(session(client));
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      }
    });
  }
}
