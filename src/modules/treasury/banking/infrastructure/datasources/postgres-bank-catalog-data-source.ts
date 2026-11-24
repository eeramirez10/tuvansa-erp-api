import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import { ConflictError } from '../../../../../shared/domain/errors/conflict-error.js';
import {
  connectPostgres, postgresConfigured, type PostgresClient, type PostgresConnectionFactory,
} from '../../../../../shared/infrastructure/database/postgres-pool.js';
import { migratePostgres } from '../../../../../shared/infrastructure/datasources/postgres-schema.js';
import type { BankCatalogReadSession, BankCatalogStorage, BankCatalogWriteSession } from '../../domain/datasources/bank-catalog-data-source.js';
import type { BankCatalogSnapshot } from '../../domain/entities/bank-catalog.js';
import type { BankAccountSearchCriteria } from '../../domain/repositories/bank-accounts-repository.js';
import { bankTransferCheque, bankTransfersAvailable } from './postgres-bank-transfers.js';

const firstId = 7800000000000;
const lastId = firstId + 99999998;
export const isLocalBankCatalogId = (id: number) => id >= firstId && id <= lastId;

const migrations = [{
  id: 'bank_catalog_accounts',
  sql: `
    CREATE SEQUENCE tuvansa.bank_catalog_ids START WITH ${firstId} MAXVALUE ${lastId};
    CREATE TABLE tuvansa.bank_catalog_accounts (
      id bigint PRIMARY KEY,
      legacy boolean NOT NULL,
      code varchar(16) NOT NULL UNIQUE,
      parent_code varchar(16),
      fields jsonb NOT NULL,
      revision integer NOT NULL CHECK (revision > 0),
      created_on date NOT NULL,
      create_key uuid UNIQUE,
      request_fingerprint char(64),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      archived_at timestamptz,
      CHECK (legacy OR (create_key IS NOT NULL AND request_fingerprint IS NOT NULL))
    );
    CREATE INDEX bank_catalog_parent ON tuvansa.bank_catalog_accounts(parent_code);
  `,
}];

const table = 'tuvansa.bank_catalog_accounts';
const columns = 'id::float8 AS id, legacy, fields, revision, created_on::text AS "createdOn", (archived_at IS NOT NULL) AS archived';
const postingChecks = {
  supplier_payments: 'bank_account_id=account.id OR supplier_account=account.code',
  customer_collections: 'bank_account_id=account.id OR client_account=account.code',
  bank_reconciliations: 'bank_account_id=account.id',
  bank_transfer_movements: 'bank_account_id=account.id',
  purchase_receptions: "accounting->'lines' @> jsonb_build_array(jsonb_build_object('account',account.code))",
  purchase_expense_batches: "accounting_lines @> jsonb_build_array(jsonb_build_object('account',account.code))",
  manual_accounting_policy_lines: "account_id=account.id OR parents @> jsonb_build_array(jsonb_build_object('id',account.id))",
};
const unavailable = () => new ApplicationError('No fue posible consultar o guardar el catálogo de bancos en PostgreSQL.', 'BANK_CATALOG_POSTGRES_UNAVAILABLE', 503);

async function available(client: PostgresClient): Promise<boolean> {
  const { rows: [row] } = await client.query<{ available: boolean }>(
    "SELECT to_regclass('tuvansa.bank_catalog_accounts') IS NOT NULL AS available",
  );
  return row?.available === true;
}

function session(client: PostgresClient): BankCatalogWriteSession {
  const find = async (column: 'id' | 'code', value: number | string) => {
    const { rows: [row] } = await client.query<BankCatalogSnapshot>(`SELECT ${columns} FROM ${table} WHERE ${column}=$1`, [value]);
    return row ?? null;
  };
  return {
    async lockAccount(id) {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('bank-reconciliation:' || $1::text || ':' || $2::text,0))", ['1', String(id)]);
    },
    async hasPostings(id, code) {
      const { rows } = await client.query<{ table_name: string }>(
        "SELECT table_name FROM information_schema.tables WHERE table_schema='tuvansa' AND table_name=ANY($1::text[])", [Object.keys(postingChecks)],
      );
      const exists = new Set(rows.map(({ table_name }) => table_name));
      const queries = Object.entries(postingChecks).filter(([table]) => exists.has(table))
        .map(([table, condition]) => `SELECT 1 FROM tuvansa.${table}, account WHERE ${condition}`);
      if (!queries.length) return false;
      const { rows: [row] } = await client.query<{ found: boolean }>(
        `WITH account AS (SELECT $1::bigint AS id,$2::text AS code)
         SELECT EXISTS(${queries.join(' UNION ALL ')}) AS found`, [id, code],
      );
      return row?.found === true;
    },
    async lastIssuedCheque(id) {
      if (!await bankTransfersAvailable(client)) return 0;
      const { rows: [row] } = await client.query<{ number: number }>(
        `SELECT coalesce(max(transfer.reference::bigint),0)::float8 AS number
         FROM tuvansa.bank_transfer_movements AS posting
         JOIN tuvansa.bank_transfers AS transfer ON transfer.id=posting.transfer_id AND transfer.company_id=posting.company_id
         WHERE posting.bank_account_id=$1 AND posting.company_id=1 AND ${bankTransferCheque}`, [id],
      );
      return row?.number ?? 0;
    },
    findById: (id) => find('id', id),
    findByCode: (code) => find('code', code),
    async hasChildren(code) {
      const { rows: [row] } = await client.query<{ found: boolean }>(
        `SELECT EXISTS(SELECT 1 FROM ${table} WHERE parent_code=$1 AND archived_at IS NULL) AS found`, [code],
      );
      return row?.found === true;
    },
    async findByRequest(requestKey, fingerprint) {
      const { rows: [row] } = await client.query<BankCatalogSnapshot & { fingerprint: string }>(
        `SELECT ${columns}, request_fingerprint AS fingerprint FROM ${table} WHERE create_key=$1`, [requestKey],
      );
      if (row && row.fingerprint !== fingerprint) {
        throw new ConflictError('La solicitud de alta ya se usó con otros datos.', 'BANK_CATALOG_REQUEST_CONFLICT');
      }
      return row ?? null;
    },
    async create({ fields, parentCode, requestKey, fingerprint, createdOn }) {
      const { rows: [row] } = await client.query<BankCatalogSnapshot>(
        `INSERT INTO ${table} (id,legacy,code,parent_code,fields,revision,created_on,create_key,request_fingerprint)
         VALUES (nextval('tuvansa.bank_catalog_ids'),false,$1,$2,$3::jsonb,1,$4,$5,$6) RETURNING ${columns}`,
        [fields.code, parentCode, JSON.stringify(fields), createdOn, requestKey, fingerprint],
      );
      if (!row) throw unavailable();
      return row;
    },
    async update({ id, legacy, fields, revision, createdOn }) {
      const input = JSON.stringify(fields);
      const { rows: [row] } = revision > 0
        ? await client.query<BankCatalogSnapshot>(
          `UPDATE ${table} SET fields=$2::jsonb,revision=revision+1,updated_at=now()
           WHERE id=$1 AND revision=$3 AND archived_at IS NULL RETURNING ${columns}`, [id, input, revision],
        )
        : await client.query<BankCatalogSnapshot>(
          `INSERT INTO ${table} (id,legacy,code,fields,revision,created_on)
           VALUES ($1,$2,$3,$4::jsonb,1,$5)
           ON CONFLICT (id) DO NOTHING RETURNING ${columns}`, [id, legacy, fields.code, input, createdOn],
        );
      if (!row) throw new ConflictError('El catálogo cambió. Vuelve a abrir Cambio.', 'BANK_CATALOG_CHANGED');
      return row;
    },
    async archive({ id, legacy, fields, revision, createdOn }) {
      const { rows } = revision > 0
        ? await client.query(
          `UPDATE ${table} SET archived_at=now(),revision=revision+1,updated_at=now()
           WHERE id=$1 AND revision=$2 AND archived_at IS NULL RETURNING id`, [id, revision],
        )
        : await client.query(
          `INSERT INTO ${table} (id,legacy,code,fields,revision,created_on,archived_at)
           VALUES ($1,$2,$3,$4::jsonb,1,$5,now())
           ON CONFLICT (id) DO NOTHING RETURNING id`, [id, legacy, fields.code, JSON.stringify(fields), createdOn],
        );
      if (!rows.length) throw new ConflictError('El catálogo cambió. Vuelve a abrir la cuenta.', 'BANK_CATALOG_CHANGED');
    },
  };
}

export class PostgresBankCatalogDataSource implements BankCatalogStorage {
  private migration?: Promise<void>;

  constructor(
    private readonly connect: PostgresConnectionFactory = connectPostgres,
    private readonly configured: () => boolean = postgresConfigured,
  ) {}

  writable(): boolean { return this.configured(); }

  private async connection<T>(callback: (client: PostgresClient) => Promise<T>): Promise<T> {
    let client: PostgresClient | undefined;
    try {
      client = await this.connect();
      return await callback(client);
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      throw unavailable();
    } finally { client?.release(); }
  }

  read<T>(fallback: T, callback: (view: BankCatalogReadSession) => Promise<T>): Promise<T> {
    if (!this.writable()) return Promise.resolve(fallback);
    return this.connection((client) => this.readOn(client, callback));
  }

  async readOn<T>(client: PostgresClient, callback: (view: BankCatalogReadSession) => Promise<T>): Promise<T> {
    const view = session(client);
    if (await available(client)) return callback(view);
    // Los movimientos pueden existir desde antes de habilitar el catálogo local.
    return callback({ ...view, findById: async () => null, findByCode: async () => null, hasChildren: async () => false });
  }

  private async readLocal<T>(fallback: T, callback: (client: PostgresClient) => Promise<T>): Promise<T> {
    if (!this.writable()) return fallback;
    return this.connection(async (client) => await available(client) ? callback(client) : fallback);
  }

  async write<T>(callback: (tx: BankCatalogWriteSession) => Promise<T>): Promise<T> {
    if (!this.writable()) throw unavailable();
    this.migration ??= this.connection((client) => migratePostgres(client, migrations)).catch((error: unknown) => {
      delete this.migration;
      throw error;
    });
    await this.migration;
    return this.connection(async (client) => {
      await client.query('BEGIN');
      try {
        await client.query('SELECT pg_advisory_xact_lock(723641)');
        const result = await callback(session(client));
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    });
  }

  firstByCode(code: string | null, previous: boolean): Promise<BankCatalogSnapshot | null> {
    const direction = previous ? 'DESC' : 'ASC';
    const filter = code === null ? '' : `AND code ${previous ? '<' : '>'} $1`;
    return this.readLocal(null as BankCatalogSnapshot | null, async (client) => {
      const { rows: [row] } = await client.query<BankCatalogSnapshot>(
        `SELECT ${columns} FROM ${table} WHERE NOT legacy AND archived_at IS NULL ${filter} ORDER BY code ${direction}, id ${direction} LIMIT 1`,
        code === null ? [] : [code],
      );
      return row ?? null;
    });
  }

  childrenOf(codes: string[]): Promise<Set<string>> {
    if (!codes.length) return Promise.resolve(new Set());
    return this.readLocal(new Set<string>(), async (client) => {
      const { rows } = await client.query<{ code: string }>(
        `SELECT DISTINCT parent_code AS code FROM ${table} WHERE parent_code=ANY($1::varchar[]) AND archived_at IS NULL`, [codes],
      );
      return new Set(rows.map(({ code }) => code));
    });
  }

  archivedLegacyIds(): Promise<number[]> {
    return this.readLocal<number[]>([], async (client) => {
      const { rows } = await client.query<{ id: number }>(
        `SELECT id::float8 AS id FROM ${table} WHERE legacy AND archived_at IS NOT NULL`,
      );
      return rows.map(({ id }) => id);
    });
  }

  search(criteria: BankAccountSearchCriteria, limit: number) {
    const conditions = ['archived_at IS NULL'];
    const values: Array<string | number> = [];
    if (criteria.query !== undefined) {
      values.push(`${criteria.query}%`);
      conditions.push("(code ILIKE $1 OR fields->>'accountNumber' ILIKE $1 OR fields->>'name' ILIKE $1)");
    }
    for (const [field, value, contains] of [
      ['code', criteria.code, false], ["fields->>'accountNumber'", criteria.accountNumber, true],
      ["fields->>'name'", criteria.name, true],
    ] as const) {
      if (value === undefined) continue;
      values.push(`${contains ? '%' : ''}${value}%`);
      conditions.push(`${field} ILIKE $${values.length}`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    values.push(limit);
    const empty = { items: [], total: 0, edits: [] };
    return this.readLocal<{ items: BankCatalogSnapshot[]; total: number; edits: number[] }>(empty, async (client) => {
      const { rows: [row] } = await client.query<{ items: BankCatalogSnapshot[]; total: number; edits: number[] }>(
        `WITH matches AS (SELECT ${columns}, code FROM ${table} ${where})
         SELECT count(*)::float8 AS total,
                ARRAY(SELECT to_jsonb(matches) FROM matches ORDER BY code,id LIMIT $${values.length}) AS items,
                ARRAY(SELECT id::float8 FROM ${table} WHERE legacy ORDER BY id) AS edits FROM matches`,
        values,
      );
      return row ?? empty;
    });
  }
}
