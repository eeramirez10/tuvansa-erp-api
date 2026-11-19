import type { PostgresClient } from '../../../../../shared/infrastructure/database/postgres-pool.js';
import { migratePostgres } from '../../../../../shared/infrastructure/datasources/postgres-schema.js';

// Derivada. Se instala de forma explícita y comparte el registro de migraciones con Pedidos.
const migrations = [{ id: '002_inventory_product_catalog', sql: `
CREATE SEQUENCE tuvansa.inventory_product_ids START WITH 5000000000 MAXVALUE 9999999999999;
CREATE TABLE tuvansa.inventory_products (
  id bigint PRIMARY KEY CHECK (id > 0 AND id <= 9999999999999),
  document jsonb NOT NULL CHECK (jsonb_typeof(document) = 'object'),
  code text GENERATED ALWAYS AS (document->>'code') STORED NOT NULL,
  active boolean GENERATED ALWAYS AS ((document->>'isActive')::boolean) STORED NOT NULL,
  deletion_relation text,
  deleted_at timestamptz,
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  CHECK ((document->>'id')::bigint = id),
  CHECK (id < 5000000000 OR revision > 0)
);
CREATE INDEX inventory_products_active_code ON tuvansa.inventory_products (lower(code), id)
WHERE deleted_at IS NULL;
CREATE TABLE tuvansa.inventory_product_units (
  id integer PRIMARY KEY,
  code text NOT NULL,
  description text NOT NULL,
  uses_color_and_size boolean NOT NULL
);
CREATE TABLE tuvansa.inventory_product_accounts (code text PRIMARY KEY);
CREATE TABLE tuvansa.inventory_product_snapshot (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  imported_at timestamptz NOT NULL DEFAULT now(),
  product_count bigint NOT NULL CHECK (product_count > 0)
);
` }];

export const migratePostgresProductCatalog = (client: PostgresClient): Promise<void> =>
  migratePostgres(client, migrations);
