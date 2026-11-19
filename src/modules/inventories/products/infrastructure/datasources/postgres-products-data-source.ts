import { ConflictError } from '../../../../../shared/domain/errors/conflict-error.js';
import type { PostgresClient, PostgresConnectionFactory } from '../../../../../shared/infrastructure/database/postgres-pool.js';
import type { ProductsDataSource } from '../../domain/datasources/products-data-source.js';
import { Product, type ProductProps } from '../../domain/entities/product.js';
import type {
  DeleteProductResult,
  ProductCreateValues,
  ProductNavigationDirection,
  ProductSearchCriteria,
  ProductSearchResult,
  ProductWriteValues,
} from '../../domain/repositories/products-repository.js';
import { applyProductWriteValues, blankProduct, type ProductUnit } from './product-catalog-record.js';
import { assertProductSnapshot, productCatalogTransaction } from './postgres-product-catalog-snapshot.js';

interface DocumentRow {
  document: ProductProps;
  deletionRelation: string | null;
}

const activeCatalogEntry = 'deleted_at IS NULL';
const selectProduct = (client: PostgresClient, productId: number) =>
  client.query<DocumentRow>(
    `SELECT document, deletion_relation AS "deletionRelation"
     FROM tuvansa.inventory_products WHERE id = $1 AND ${activeCatalogEntry}`,
    [productId],
  );

const codeExists = async (client: PostgresClient, code: string, excludingId?: number) =>
  (await client.query(
    `SELECT 1 FROM tuvansa.inventory_products
     WHERE lower(code) = lower($1) AND ($2::bigint IS NULL OR id <> $2)
       AND ${activeCatalogEntry} LIMIT 1`,
    [code, excludingId ?? null],
  )).rows.length > 0;

const findUnit = async (client: PostgresClient, unitId: number) =>
  (await client.query<ProductUnit>(
    `SELECT id, code, description, uses_color_and_size AS "usesColorAndSize"
     FROM tuvansa.inventory_product_units WHERE id = $1`,
    [unitId],
  )).rows[0];

const accountingAccountExists = async (client: PostgresClient, account: string) =>
  (await client.query(
    'SELECT 1 FROM tuvansa.inventory_product_accounts WHERE code = lower($1)',
    [account],
  )).rows.length > 0;

const toProduct = (row?: Pick<DocumentRow, 'document'>): Product | null =>
  row ? Product.create(row.document) : null;

const validateAccounts = async (client: PostgresClient, values: ProductWriteValues): Promise<void> => {
  for (const account of [values.primaryAccount, values.secondaryAccount, values.costOfSalesAccount]) {
    if (account && !(await accountingAccountExists(client, account))) {
      throw new ConflictError(`La cuenta contable ${account} no existe`, 'ACCOUNTING_ACCOUNT_NOT_FOUND');
    }
  }
};

const hasLocalOrderReference = async (client: PostgresClient, productId: number): Promise<boolean> => {
  const module = await client.query<{ exists: boolean }>(
    "SELECT to_regclass('tuvansa.orders') IS NOT NULL AS exists",
  );
  if (module.rows[0]?.exists !== true) return false;
  const result = await client.query(
    `SELECT 1 FROM tuvansa.orders
     WHERE document @> jsonb_build_object('lines', jsonb_build_array(jsonb_build_object('productId', $1::bigint)))
        OR base_document @> jsonb_build_object('lines', jsonb_build_array(jsonb_build_object('productId', $1::bigint)))
     LIMIT 1`,
    [productId],
  );
  return result.rows.length > 0;
};

// Derivada. El origen se intercambiará cuando también se concilien las lecturas dependientes.
export class PostgresProductsDataSource implements ProductsDataSource {
  constructor(private readonly connect: PostgresConnectionFactory) {}

  private async read<T>(operation: (client: PostgresClient) => Promise<T>): Promise<T> {
    const client = await this.connect();
    try {
      await assertProductSnapshot(client);
      return await operation(client);
    } finally {
      client.release();
    }
  }

  private write<T>(operation: (client: PostgresClient) => Promise<T>): Promise<T> {
    return productCatalogTransaction(this.connect, async (client) => {
      await assertProductSnapshot(client);
      return operation(client);
    });
  }

  findById(productId: number): Promise<Product | null> {
    return this.read(async (client) => toProduct((await selectProduct(client, productId)).rows[0]));
  }

  findFirstActive(): Promise<Product | null> {
    return this.read(async (client) => {
      const result = await client.query<{ document: ProductProps }>(
        `SELECT document FROM tuvansa.inventory_products WHERE active AND ${activeCatalogEntry}
         ORDER BY lower(code), id LIMIT 1`,
      );
      return toProduct(result.rows[0]);
    });
  }

  search(criteria: ProductSearchCriteria): Promise<ProductSearchResult> {
    return this.read(async (client) => {
      const active = criteria.status === 'all' ? null : criteria.status === 'active';
      const search = criteria.query === undefined ? null : `%${criteria.query}%`;
      const result = await client.query<{ total: string; items: ProductProps[] }>(
        `WITH matching AS (
           SELECT id, code, document FROM tuvansa.inventory_products
           WHERE ${activeCatalogEntry} AND ($1::boolean IS NULL OR active = $1)
             AND ($2::text IS NULL OR code ILIKE $2 OR document->>'description' ILIKE $2
               OR document #>> '{warehouse,ean}' ILIKE $2 OR document #>> '{warehouse,upc}' ILIKE $2)
         )
         SELECT (SELECT count(*)::text FROM matching) AS total,
           ARRAY(SELECT document FROM matching ORDER BY lower(code), id LIMIT $3 OFFSET $4) AS items`,
        [active, search, criteria.limit, criteria.offset],
      );
      const page = result.rows[0];
      return { total: Number(page?.total ?? 0), items: (page?.items ?? []).map(Product.create) };
    });
  }

  findAdjacent(productId: number, direction: ProductNavigationDirection): Promise<Product | null> {
    return this.read(async (client) => {
      const operator = direction === 'previous' ? '<' : '>';
      const order = direction === 'previous' ? 'DESC' : 'ASC';
      const result = await client.query<{ document: ProductProps }>(
        `SELECT adjacent.document
         FROM tuvansa.inventory_products current_product
         JOIN tuvansa.inventory_products adjacent
           ON lower(adjacent.code) ${operator} lower(current_product.code)
         WHERE current_product.id = $1 AND current_product.deleted_at IS NULL AND adjacent.deleted_at IS NULL
         ORDER BY lower(adjacent.code) ${order}, adjacent.id ${order} LIMIT 1`,
        [productId],
      );
      return toProduct(result.rows[0]);
    });
  }

  codeExists(code: string, excludingProductId?: number): Promise<boolean> {
    return this.read((client) => codeExists(client, code, excludingProductId));
  }

  unitExists(unitId: number): Promise<boolean> {
    return this.read(async (client) => (await findUnit(client, unitId)) !== undefined);
  }

  accountingAccountExists(account: string): Promise<boolean> {
    return this.read((client) => accountingAccountExists(client, account));
  }

  create(values: ProductCreateValues): Promise<Product> {
    return this.write(async (client) => {
      if (await codeExists(client, values.code)) {
        throw new ConflictError('Ya existe un producto con ese código', 'PRODUCT_CODE_EXISTS');
      }
      const unit = await findUnit(client, values.unitId ?? 1);
      if (!unit) throw new ConflictError('La unidad no existe', 'PRODUCT_UNIT_NOT_FOUND');
      await validateAccounts(client, values);
      const created = await client.query<{ id: string; date: string }>(
        `SELECT nextval('tuvansa.inventory_product_ids')::text AS id, CURRENT_DATE::text AS date`,
      );
      const { id, date } = created.rows[0]!;
      const document = applyProductWriteValues(blankProduct(Number(id), date), values, unit);
      await client.query(
        'INSERT INTO tuvansa.inventory_products (id, document, revision) VALUES ($1, $2, 1)',
        [id, document],
      );
      return Product.create(document);
    });
  }

  update(productId: number, values: ProductWriteValues): Promise<Product | null> {
    return this.write(async (client) => {
      const product = (await selectProduct(client, productId)).rows[0];
      if (!product) return null;
      if (values.code && values.code !== product.document.code && await codeExists(client, values.code, productId)) {
        throw new ConflictError('Ya existe un producto con ese código', 'PRODUCT_CODE_EXISTS');
      }
      const unit = values.unitId === undefined ? undefined : await findUnit(client, values.unitId);
      if (values.unitId !== undefined && !unit) {
        throw new ConflictError('La unidad no existe', 'PRODUCT_UNIT_NOT_FOUND');
      }
      await validateAccounts(client, values);
      const document = applyProductWriteValues(product.document, values, unit);
      await client.query(
        'UPDATE tuvansa.inventory_products SET document = $2, revision = revision + 1 WHERE id = $1',
        [productId, document],
      );
      return Product.create(document);
    });
  }

  delete(productId: number): Promise<DeleteProductResult> {
    return this.write(async (client) => {
      const product = (await selectProduct(client, productId)).rows[0];
      if (!product) return { status: 'not-found' };
      if (product.deletionRelation) return { status: 'in-use', relation: product.deletionRelation };
      if (await hasLocalOrderReference(client, productId)) return { status: 'in-use', relation: 'Pedidos' };
      await client.query(
        'UPDATE tuvansa.inventory_products SET deleted_at = now(), revision = revision + 1 WHERE id = $1',
        [productId],
      );
      return { status: 'deleted' };
    });
  }
}
