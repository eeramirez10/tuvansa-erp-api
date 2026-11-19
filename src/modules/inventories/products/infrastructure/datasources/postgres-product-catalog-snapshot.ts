import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import type { PostgresClient, PostgresConnectionFactory } from '../../../../../shared/infrastructure/database/postgres-pool.js';
import type { ProductProps } from '../../domain/entities/product.js';
import type { ProductUnit } from './product-catalog-record.js';

export interface LegacyProductSnapshot {
  products: AsyncIterable<readonly { document: ProductProps; deletionRelation: string | null }[]>;
  units: readonly ProductUnit[];
  accounts: readonly string[];
  totals: {
    productCount: number;
    currentStock: string;
    previousStock: string;
    pieceStock: string;
  };
}

export const productCatalogTransaction = async <T>(
  connect: PostgresConnectionFactory,
  operation: (client: PostgresClient) => Promise<T>,
): Promise<T> => {
  const client = await connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(715002)');
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

export const assertProductSnapshot = async (client: PostgresClient): Promise<void> => {
  const result = await client.query('SELECT 1 FROM tuvansa.inventory_product_snapshot WHERE singleton');
  if (result.rows.length === 0) {
    throw new ApplicationError('El catálogo PostgreSQL requiere una copia de PROSCAI conciliada.', 'PRODUCT_SNAPSHOT_REQUIRED', 503);
  }
};

// Derivada. Reemplaza únicamente un catálogo que todavía no haya recibido cambios locales.
export const stageProductCatalog = (
  connect: PostgresConnectionFactory,
  snapshot: LegacyProductSnapshot,
): Promise<LegacyProductSnapshot['totals']> =>
  productCatalogTransaction(connect, async (client) => {
    if (!Number.isSafeInteger(snapshot.totals.productCount) || snapshot.totals.productCount < 1) {
      throw new Error('La copia de PROSCAI no contiene un catálogo válido');
    }
    const edits = await client.query('SELECT 1 FROM tuvansa.inventory_products WHERE revision > 0 LIMIT 1');
    if (edits.rows.length > 0) throw new Error('El catálogo PostgreSQL ya tiene cambios locales');
    await client.query('DELETE FROM tuvansa.inventory_products');
    await client.query('DELETE FROM tuvansa.inventory_product_units');
    await client.query('DELETE FROM tuvansa.inventory_product_accounts');
    await client.query(
      `INSERT INTO tuvansa.inventory_product_units (id, code, description, uses_color_and_size)
       SELECT id, code, description, "usesColorAndSize"
       FROM jsonb_to_recordset($1::jsonb) AS units(id int, code text, description text, "usesColorAndSize" boolean)`,
      [JSON.stringify(snapshot.units)],
    );
    await client.query(
      'INSERT INTO tuvansa.inventory_product_accounts (code) SELECT DISTINCT lower(unnest($1::text[]))',
      [snapshot.accounts],
    );
    for await (const batch of snapshot.products) {
      await client.query(
        `INSERT INTO tuvansa.inventory_products (id, document, deletion_relation)
         SELECT (document->>'id')::bigint, document, "deletionRelation"
         FROM jsonb_to_recordset($1::jsonb) AS products(document jsonb, "deletionRelation" text)`,
        [JSON.stringify(batch)],
      );
    }
    const { productCount, currentStock, previousStock, pieceStock } = snapshot.totals;
    const result = await client.query<{ reconciled: boolean }>(
      `SELECT count(*) = $1::bigint
           AND coalesce(sum((document #>> '{accumulated,currentStock}')::numeric(30,6)), 0) = $2::numeric
           AND coalesce(sum((document #>> '{accumulated,previousStock}')::numeric(30,6)), 0) = $3::numeric
           AND coalesce(sum((document #>> '{accumulated,pieceStock}')::numeric(30,6)), 0) = $4::numeric
         AS reconciled
       FROM tuvansa.inventory_products`,
      [productCount, currentStock, previousStock, pieceStock],
    );
    if (result.rows[0]?.reconciled !== true) throw new Error('El catálogo PostgreSQL no concilió con la copia de PROSCAI');
    await client.query(
      `INSERT INTO tuvansa.inventory_product_snapshot (product_count) VALUES ($1)
       ON CONFLICT (singleton) DO UPDATE SET product_count = excluded.product_count, imported_at = now()`,
      [productCount],
    );
    return snapshot.totals;
  });
