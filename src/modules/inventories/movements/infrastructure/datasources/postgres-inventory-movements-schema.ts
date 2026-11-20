import { createHash } from 'node:crypto';
import type { PostgresClient } from '../../../../../shared/infrastructure/database/postgres-pool.js';

// Derivada. Usa el registro y el bloqueo de migraciones de PostgreSQL que ya usa Pedidos.
const migration = {
  id: '003_inventory_movements',
  sql: `
CREATE TABLE tuvansa.inventory_movement_opening (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  warehouse_tracking boolean,
  layer_effects boolean,
  transit_effects boolean,
  staged_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE tuvansa.inventory_movement_documents (
  id bigint PRIMARY KEY CHECK (id > 0 AND id <= 9007199254740991),
  original_document jsonb NOT NULL CHECK (jsonb_typeof(original_document) = 'object'),
  cancelled_document jsonb,
  cancelled_at timestamptz,
  CHECK ((original_document #>> '{header,id}')::bigint IS NOT DISTINCT FROM id),
  CHECK ((cancelled_document IS NULL) = (cancelled_at IS NULL))
);
CREATE INDEX inventory_movement_documents_folio
  ON tuvansa.inventory_movement_documents (lower(original_document #>> '{header,document}'), id);
CREATE TABLE tuvansa.inventory_movement_product_balances (
  product_id bigint PRIMARY KEY CHECK (product_id > 0 AND product_id <= 9007199254740991),
  quantity numeric NOT NULL,
  pieces numeric NOT NULL
);
CREATE TABLE tuvansa.inventory_movement_warehouse_balances (
  product_id bigint NOT NULL REFERENCES tuvansa.inventory_movement_product_balances(product_id),
  warehouse text NOT NULL CHECK (warehouse <> ''),
  quantity numeric NOT NULL,
  PRIMARY KEY (product_id, warehouse)
);
`,
};

export const migrateInventoryMovements = async (client: PostgresClient): Promise<void> => {
  await client.query('BEGIN');
  try {
    await client.query('SELECT pg_advisory_xact_lock(715001)');
    await client.query('CREATE SCHEMA IF NOT EXISTS tuvansa');
    await client.query(`CREATE TABLE IF NOT EXISTS tuvansa.schema_migrations (
      id text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    const checksum = createHash('sha256').update(migration.sql).digest('hex');
    const existing = (await client.query<{ checksum: string }>(
      'SELECT checksum FROM tuvansa.schema_migrations WHERE id = $1',
      [migration.id],
    )).rows[0];
    if (existing) {
      if (existing.checksum !== checksum) throw new Error('El checksum de la migración de movimientos no coincide');
    } else {
      await client.query(migration.sql);
      await client.query('INSERT INTO tuvansa.schema_migrations (id, checksum) VALUES ($1, $2)', [migration.id, checksum]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
};
