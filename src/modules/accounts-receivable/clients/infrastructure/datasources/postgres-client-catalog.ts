import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import { ConflictError } from '../../../../../shared/domain/errors/conflict-error.js';
import { connectPostgres, postgresConfigured, postgresUnavailable, type PostgresClient } from '../../../../../shared/infrastructure/database/postgres-pool.js';
import { migratePostgres } from '../../../../../shared/infrastructure/datasources/postgres-schema.js';
import type { ClientBlockStatus } from '../../domain/entities/client-action.js';
import type { ClientCatalogRecord } from '../../domain/entities/client-catalog.js';

const firstId = 1600000000;
const lastId = firstId + 99999999;
export const isLocalClientCatalogId = (id: number) => id >= firstId && id <= lastId;

const migrations = [{ id: 'client_catalog', sql: `
  CREATE SEQUENCE tuvansa.client_catalog_ids START WITH ${firstId} MAXVALUE ${lastId};
  CREATE SEQUENCE tuvansa.client_block_event_ids START WITH 1700000000;
  CREATE TABLE tuvansa.client_catalog (
    id bigint PRIMARY KEY,
    legacy boolean NOT NULL,
    original_code text,
    code text NOT NULL,
    document jsonb NOT NULL CHECK(jsonb_typeof(document)='object'),
    changes jsonb NOT NULL CHECK(jsonb_typeof(changes)='object'),
    blocked boolean,
    blocked_at date,
    deleted_at timestamptz,
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK ((document->>'id')::bigint=id AND document->>'code'=code),
    CHECK ((blocked IS TRUE) = (blocked_at IS NOT NULL))
  );
  CREATE UNIQUE INDEX client_catalog_code ON tuvansa.client_catalog(lower(code));
  CREATE TABLE tuvansa.client_block_events (
    id bigint PRIMARY KEY DEFAULT nextval('tuvansa.client_block_event_ids'),
    client_id bigint NOT NULL REFERENCES tuvansa.client_catalog(id),
    event_key text NOT NULL,
    date date NOT NULL,
    blocked boolean NOT NULL,
    reason text NOT NULL CHECK(length(trim(reason))>0)
  );
  CREATE INDEX client_block_events_client ON tuvansa.client_block_events(client_id,id);
` }];

const columns = `document,changes,legacy,original_code AS "originalCode",deleted_at IS NOT NULL AS deleted,blocked,blocked_at::text AS "blockedAt"`;
const unavailable = () => new ApplicationError('No fue posible consultar o guardar clientes en PostgreSQL.', 'CLIENT_CATALOG_POSTGRES_UNAVAILABLE', 503);

async function withClient<T>(operation: (client: PostgresClient) => Promise<T>) {
  let client: PostgresClient | undefined;
  try {
    client = await connectPostgres();
    return await operation(client);
  } catch (error) {
    if (error instanceof ApplicationError) throw error;
    throw unavailable();
  } finally { client?.release(); }
}

async function available(client: PostgresClient): Promise<boolean> {
  const { rows: [table] } = await client.query<{ exists: boolean }>("SELECT to_regclass('tuvansa.client_catalog') IS NOT NULL AS exists");
  return table?.exists === true;
}

export function clientCatalogRecords(ids: number[], client?: PostgresClient): Promise<Map<number, ClientCatalogRecord>> {
  if (!ids.length) return Promise.resolve(new Map());
  const read = async (client: PostgresClient) => {
    if (!await available(client)) return new Map<number, ClientCatalogRecord>();
    const { rows } = await client.query<ClientCatalogRecord>(`SELECT ${columns} FROM tuvansa.client_catalog WHERE id=ANY($1::bigint[])`, [ids]);
    return new Map(rows.map((record) => [record.document.id, record]));
  };
  return client ? read(client) : postgresConfigured() ? withClient(read) : Promise.resolve(new Map());
}

export async function clientCatalogRecord(id: number, client?: PostgresClient): Promise<ClientCatalogRecord | null> {
  return (await clientCatalogRecords([id], client)).get(id) ?? null;
}

export function findClientCatalogByCode(code: string): Promise<ClientCatalogRecord | null> {
  if (!postgresConfigured()) return Promise.resolve(null);
  return withClient(async (client) => {
    if (!await available(client)) return null;
    const { rows: [record] } = await client.query<ClientCatalogRecord>(
      `SELECT ${columns} FROM tuvansa.client_catalog WHERE lower(code)=lower($1) OR lower(original_code)=lower($1)
       ORDER BY lower(code)=lower($1) DESC,id LIMIT 1`, [code],
    );
    return record ?? null;
  });
}

export function allClientCatalogRecords(): Promise<ClientCatalogRecord[]> {
  if (!postgresConfigured()) return Promise.resolve([]);
  return withClient(async (client) => await available(client)
    ? (await client.query<ClientCatalogRecord>(`SELECT ${columns} FROM tuvansa.client_catalog ORDER BY lower(code),id`)).rows : []);
}

export async function lockClientCatalogCredit(client: PostgresClient, id: number) {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('sales-credit:1:' || $1::text,0))", [id]);
}

export async function assertClientCatalogCreditAllowed(client: PostgresClient, id: number) {
  await lockClientCatalogCredit(client, id);
  const record = await clientCatalogRecord(id, client);
  if (record?.deleted || record?.blocked === true || (isLocalClientCatalogId(id) && !(record?.blocked === false || record?.document.isActive))) {
    throw new ConflictError('El cliente está bloqueado o fue dado de baja.', 'CLIENT_CREDIT_BLOCKED');
  }
  return record;
}

type BlockEvent = NonNullable<ClientBlockStatus['event']>;

export function clientCatalogBlockEvent(clientId: number): Promise<BlockEvent | null> {
  if (!postgresConfigured()) return Promise.resolve(null);
  return withClient(async (client) => {
    if (!await available(client)) return null;
    const { rows: [record] } = await client.query<BlockEvent>(
      `SELECT min(id)::float8 AS id,(array_agg(date ORDER BY id DESC))[1]::text AS date,'BLOQUEO' AS title,max(event_key) AS key,
         string_agg(rpad(CASE WHEN blocked THEN 'BLOQUEO' ELSE 'DESBLOQUEO' END,13,' ')
           || to_char(date,'DD/MM/YYYY') || '  0       ' || reason,chr(13) ORDER BY id) AS description
       FROM tuvansa.client_block_events WHERE client_id=$1 GROUP BY client_id`, [clientId],
    );
    return record ?? null;
  });
}

const dependencyQueries = {
  orders: "dep.document#>>'{customer,id}'=target.id::text OR dep.base_document#>>'{customer,id}'=target.id::text",
  sales_remissions: 'dep.customer_id=target.id',
  customer_collections: 'dep.client_id=target.id',
  client_block_events: 'target.renaming AND dep.client_id=target.id',
  client_catalog: "dep.id<>target.id AND dep.deleted_at IS NULL AND target.code<>'' AND lower(dep.document#>>'{terms,applyToClientCode}')=lower(target.code)",
};

export class PostgresClientCatalog {
  private migration?: Promise<void>;

  async write<T>(operation: (client: PostgresClient) => Promise<T>): Promise<T> {
    if (!postgresConfigured()) throw postgresUnavailable();
    this.migration ??= withClient((client) => migratePostgres(client, migrations)).catch((error: unknown) => {
      delete this.migration;
      throw error;
    });
    await this.migration;
    return withClient(async (client) => {
      await client.query('BEGIN');
      try {
        await client.query('SELECT pg_advisory_xact_lock(715004)');
        const result = await operation(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      }
    });
  }

  async allocate(client: PostgresClient) {
    const { rows: [row] } = await client.query<{ id: string }>("SELECT nextval('tuvansa.client_catalog_ids') AS id");
    return Number(row!.id);
  }

  async save(client: PostgresClient, { document, changes, legacy, originalCode, blocked, blockedAt, deleted }: ClientCatalogRecord) {
    await client.query(`INSERT INTO tuvansa.client_catalog (id,code,legacy,original_code,document,changes,blocked,blocked_at,deleted_at)
      VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,CASE WHEN $9::boolean THEN now() END)
      ON CONFLICT(id) DO UPDATE SET code=excluded.code,document=excluded.document,changes=excluded.changes,
        blocked=excluded.blocked,blocked_at=excluded.blocked_at,deleted_at=excluded.deleted_at,updated_at=now()`,
    [document.id, document.code, legacy, originalCode, JSON.stringify(document), JSON.stringify(changes), blocked, blockedAt, deleted]);
  }

  async codeExists(client: PostgresClient, code: string, excludingClientId = 0) {
    const { rows } = await client.query('SELECT id FROM tuvansa.client_catalog WHERE lower(code)=lower($1) AND id<>$2', [code, excludingClientId]);
    return rows.length > 0;
  }

  async dependency(client: PostgresClient, id: number, code: string, renaming: boolean): Promise<string | null> {
    const { rows } = await client.query<{ table_name: keyof typeof dependencyQueries }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema='tuvansa' AND table_name=ANY($1::text[])",
      [Object.keys(dependencyQueries)],
    );
    if (!rows.length) return null;
    const queries = rows.map(({ table_name }) =>
      `SELECT '${table_name}' AS relation WHERE EXISTS(SELECT 1 FROM tuvansa.${table_name} dep CROSS JOIN target WHERE ${dependencyQueries[table_name]})`);
    const { rows: [first] } = await client.query<{ relation: string }>(
      `WITH target AS (SELECT $1::bigint AS id,$2::text AS code,$3::boolean AS renaming) ${queries.join(' UNION ALL ')} LIMIT 1`, [id, code, renaming],
    );
    return first?.relation ?? null;
  }

  async createBlockEvent(client: PostgresClient, id: number, code: string, date: string, blocked: boolean, reason: string) {
    await client.query(`INSERT INTO tuvansa.client_block_events (client_id,event_key,date,blocked,reason) VALUES($1,$2,$3,$4,$5)`,
      [id, `${code.padEnd(6, ' ').slice(0, 6)}BLOQUE`, date, blocked, reason]);
  }
}
