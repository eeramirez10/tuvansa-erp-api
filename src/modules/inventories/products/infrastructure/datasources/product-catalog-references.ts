import { ConflictError } from '../../../../../shared/domain/errors/conflict-error.js';
import { connectPostgres, postgresConfigured, type PostgresClient } from '../../../../../shared/infrastructure/database/postgres-pool.js';
import type { ProductProps } from '../../domain/entities/product.js';
import type { ProductOtherDataValues } from '../../domain/entities/product-other-data.js';
import { productCatalogAvailable } from './postgres-product-catalog-snapshot.js';

export const firstLocalCatalogProductId = 5000000000;
export const isNewCatalogProduct = (id: number) => id >= firstLocalCatalogProductId;

export interface CatalogReference {
  document: ProductProps;
  deleted: boolean;
  revision: number;
}

const fields = 'document,deleted_at IS NOT NULL AS deleted,revision';

async function readCatalog<T>(fallback: T, read: (client: PostgresClient) => Promise<T>, transaction?: PostgresClient): Promise<T> {
  if (transaction) return await productCatalogAvailable(transaction) ? read(transaction) : fallback;
  if (!postgresConfigured()) return fallback;
  const client = await connectPostgres();
  try { return await productCatalogAvailable(client) ? await read(client) : fallback; }
  finally { client.release(); }
}

export function catalogProductsById(ids: number[], transaction?: PostgresClient) {
  if (!ids.length) return Promise.resolve(new Map<number, CatalogReference>());
  return readCatalog(new Map<number, CatalogReference>(), async (client) => {
    const { rows } = await client.query<CatalogReference>(
      `SELECT ${fields} FROM tuvansa.inventory_products WHERE id=ANY($1::bigint[]) ORDER BY id ${transaction ? 'FOR NO KEY UPDATE' : ''}`, [ids],
    );
    return new Map(rows.map((reference) => [reference.document.id, reference]));
  }, transaction);
}

export function changedCatalogProductsByCode(codes: string[]) {
  if (!codes.length) return Promise.resolve([]);
  return readCatalog<CatalogReference[]>([], async (client) => (await client.query<CatalogReference>(
    `SELECT ${fields} FROM tuvansa.inventory_products
     WHERE revision>0 AND deleted_at IS NULL AND lower(code)=ANY($1::text[]) ORDER BY lower(code),id`,
    [codes.map((code) => code.toLowerCase())],
  )).rows);
}

export function catalogOtherData(ids: number[], transaction?: PostgresClient) {
  if (!ids.length) return Promise.resolve(new Map<number, ProductOtherDataValues>());
  return readCatalog(new Map<number, ProductOtherDataValues>(), async (client) => {
    const { rows: [table] } = await client.query<{ available: boolean }>(
      "SELECT to_regclass('tuvansa.inventory_product_other_data') IS NOT NULL AS available",
    );
    if (!table?.available) return new Map();
    const { rows } = await client.query<{ id: string; changes: ProductOtherDataValues }>(
      'SELECT product_id AS id,changes FROM tuvansa.inventory_product_other_data WHERE product_id=ANY($1::bigint[])', [ids],
    );
    return new Map(rows.map(({ id, changes }) => [Number(id), changes]));
  }, transaction);
}

export function catalogProductByIdentifier(identifier: string, byBarcode = false) {
  return readCatalog<CatalogReference | null>(null, async (client) => {
    const { rows: [reference] } = await client.query<CatalogReference>(
      `SELECT ${fields} FROM tuvansa.inventory_products
       WHERE lower(code)=lower($1) OR ($2 AND lower(document #>> '{warehouse,ean}')=lower($1))
       ORDER BY deleted_at IS NOT NULL, CASE WHEN $2 AND lower(document #>> '{warehouse,ean}')=lower($1) THEN 0 ELSE 1 END,id
       LIMIT 1`, [identifier, byBarcode],
    );
    return reference ?? null;
  });
}

export function searchChangedCatalogProducts(code: string, description: string, limit: number) {
  return readCatalog<CatalogReference[]>([], async (client) => (await client.query<CatalogReference>(
    `SELECT ${fields} FROM tuvansa.inventory_products
     WHERE revision>0 AND deleted_at IS NULL AND active
       AND ($1='' OR starts_with(lower(code),lower($1)) OR starts_with(lower(coalesce(document #>> '{warehouse,ean}','')),lower($1)))
       AND strpos(lower(document->>'description'),lower($2))>0
     ORDER BY lower(code)=lower($1) DESC,lower(code),id LIMIT $3`,
    [code, description, limit],
  )).rows);
}

export async function assertActiveCatalogProducts(client: PostgresClient, ids: number[]): Promise<void> {
  if (!ids.length || !await productCatalogAvailable(client)) return;
  await client.query('SELECT pg_advisory_xact_lock(715002)');
  const { rows: [blocked] } = await client.query<{ code: string }>(
    `SELECT code FROM tuvansa.inventory_products
     WHERE id=ANY($1::bigint[]) AND (deleted_at IS NOT NULL OR NOT active) ORDER BY id LIMIT 1`, [ids],
  );
  if (blocked) throw new ConflictError(`El producto ${blocked.code} está dado de baja.`, 'PRODUCT_NOT_ACTIVE');
}
