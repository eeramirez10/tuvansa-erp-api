import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import type { PostgresClient, PostgresConnectionFactory } from '../../../../../shared/infrastructure/database/postgres-pool.js';
import type { ProductProps } from '../../domain/entities/product.js';
import type { ProductWriteValues } from '../../domain/repositories/products-repository.js';
import type { ProductOtherDataValues } from '../../domain/entities/product-other-data.js';
import { applyProductWriteValues, type ProductUnit } from './product-catalog-record.js';

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

export async function productCatalogAvailable(client: PostgresClient): Promise<boolean> {
  const { rows: [table] } = await client.query<{ exists: boolean }>(
    "SELECT to_regclass('tuvansa.inventory_product_snapshot') IS NOT NULL AS exists",
  );
  if (!table?.exists) return false;
  return (await client.query('SELECT 1 FROM tuvansa.inventory_product_snapshot WHERE singleton')).rows.length > 0;
}

async function adoptPriorEdits(client: PostgresClient, units: readonly ProductUnit[]) {
  const sources = [
    ['inventory_product_catalog_edits', 'e.product_id,e.changes,NULL::text,NULL::jsonb'],
    ['inventory_product_classifications', 'e.product_id,NULL::jsonb,e.family_code,NULL::jsonb'],
    ['inventory_product_other_data', 'e.product_id,NULL::jsonb,NULL::text,e.changes'],
  ] as const;
  const { rows } = await client.query<{ name: string }>(
    "SELECT name FROM unnest($1::text[]) name WHERE to_regclass('tuvansa.'||name) IS NOT NULL",
    [sources.map(([name]) => name)],
  );
  const present = new Set(rows.map(({ name }) => name));
  const union = sources.filter(([name]) => present.has(name)).map(([name, fields]) =>
    `SELECT ${fields} FROM tuvansa.${name} e`);
  if (!union.length) return;
  const { rows: edits } = await client.query<{
    productId: string; document: ProductProps; catalog: ProductWriteValues | null; family: string | null; other: ProductOtherDataValues | null;
  }>(
    `WITH prior(product_id,catalog,family,other_data) AS (${union.join(' UNION ALL ')})
     SELECT p.id AS "productId",p.document,
        (SELECT catalog FROM prior WHERE product_id=p.id AND catalog IS NOT NULL) AS catalog,
        (SELECT family FROM prior WHERE product_id=p.id AND family IS NOT NULL) AS family,
        (SELECT other_data FROM prior WHERE product_id=p.id AND other_data IS NOT NULL) AS other
     FROM tuvansa.inventory_products p WHERE p.id IN (SELECT product_id FROM prior)`,
  );
  for (const row of edits) {
    const other = row.other;
    const values: ProductWriteValues = {
      ...row.catalog,
      ...(row.family === null ? {} : { familyCode: row.family }),
      ...(typeof other?.list4 === 'number' ? { averageCost: other.list4 } : {}),
      ...(typeof other?.list5 === 'number' ? { lastCost: other.list5 } : {}),
      ...(typeof other?.list6 === 'number' ? { previousCost: other.list6 } : {}),
      ...(typeof other?.currency6 === 'number' ? { costCurrency: other.currency6 } : {}),
      ...(typeof other?.location === 'string' ? { location: other.location } : {}),
    };
    const unit = values.unitId === undefined ? undefined : units.find(({ id }) => id === values.unitId);
    await client.query('UPDATE tuvansa.inventory_products SET document=$2,revision=1 WHERE id=$1',
      [row.productId, applyProductWriteValues(row.document, values, unit)]);
  }
}

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
    await adoptPriorEdits(client, snapshot.units);
    await client.query(
      `INSERT INTO tuvansa.inventory_product_snapshot (product_count) VALUES ($1)
       ON CONFLICT (singleton) DO UPDATE SET product_count = excluded.product_count, imported_at = now()`,
      [productCount],
    );
    return snapshot.totals;
  });
