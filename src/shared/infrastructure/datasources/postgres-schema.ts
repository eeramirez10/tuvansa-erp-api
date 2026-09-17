import { createHash } from 'node:crypto';
import type { PostgresClient } from '../database/postgres-pool.js';

// DERIVADA: persistence owned by this API, not SQL captured from OMNIS.
export const postgresMigrations = [{ id: '001_orders_overlay', sql: `
CREATE SEQUENCE tuvansa.order_ids START WITH 5000000000 MAXVALUE 9999999999999;
CREATE TABLE tuvansa.orders (
  id bigint PRIMARY KEY CHECK (id > 0 AND id <= 9007199254740991),
  legacy_id bigint UNIQUE,
  number varchar(15) NOT NULL,
  document jsonb NOT NULL CHECK (jsonb_typeof(document) = 'object'),
  base_document jsonb,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((legacy_id IS NULL AND id >= 5000000000 AND base_document IS NULL)
    OR (legacy_id = id AND id < 5000000000 AND base_document IS NOT NULL)),
  CHECK ((document->>'id')::bigint = id AND document->>'number' = number)
);
CREATE UNIQUE INDEX orders_number_unique ON tuvansa.orders (lower(number));
CREATE INDEX orders_active_number ON tuvansa.orders (number,id) WHERE deleted_at IS NULL;
CREATE TABLE tuvansa.order_changes (
  order_id bigint NOT NULL REFERENCES tuvansa.orders(id),
  revision integer NOT NULL,
  operation varchar(12) NOT NULL CHECK (operation IN ('create','update','delete','convert')),
  document jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (order_id,revision)
);
CREATE TABLE tuvansa.order_stock_deltas (
  order_id bigint NOT NULL REFERENCES tuvansa.orders(id),
  product_id bigint NOT NULL,
  warehouse varchar(6) NOT NULL,
  ordered numeric(18,3) NOT NULL,
  quoted numeric(18,3) NOT NULL,
  PRIMARY KEY (order_id,product_id,warehouse)
);
CREATE INDEX order_stock_product ON tuvansa.order_stock_deltas(product_id,warehouse);
` }];

export async function migratePostgres(client: PostgresClient): Promise<void> {
  await client.query('BEGIN');
  try {
    // Transaction-scoped lock also works with a Neon transaction pooler.
    await client.query('SELECT pg_advisory_xact_lock(715001)');
    await client.query('CREATE SCHEMA IF NOT EXISTS tuvansa');
    await client.query(`CREATE TABLE IF NOT EXISTS tuvansa.schema_migrations (
      id text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    for (const migration of postgresMigrations) {
      const checksum = createHash('sha256').update(migration.sql).digest('hex');
      const existing = await client.query<{checksum: string}>('SELECT checksum FROM tuvansa.schema_migrations WHERE id=$1', [migration.id]);
      if (existing.rows[0]) {
        if (existing.rows[0].checksum !== checksum) throw new Error('El checksum de una migración PostgreSQL aplicada no coincide');
        continue;
      }
      await client.query(migration.sql);
      await client.query('INSERT INTO tuvansa.schema_migrations(id,checksum) VALUES ($1,$2)', [migration.id, checksum]);
    }
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
}
