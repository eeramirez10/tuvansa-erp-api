import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import { ConflictError } from '../../../../../shared/domain/errors/conflict-error.js';
import {
  connectPostgres,
  postgresConfigured,
  type PostgresClient,
  type PostgresConnectionFactory,
} from '../../../../../shared/infrastructure/database/postgres-pool.js';
import { migratePostgres } from '../../../../../shared/infrastructure/datasources/postgres-schema.js';
import {
  productCatalogEditRevision,
  type ProductCatalogEditChanges,
  type ProductCatalogEditDataSource,
  type ProductCatalogEditSnapshot,
} from '../../domain/datasources/product-catalog-edit-data-source.js';
import type { ProductWriteValues } from '../../domain/repositories/products-repository.js';
import { migrateProductClassification, PostgresProductClassificationDataSource } from './postgres-product-classification-data-source.js';
import { migrateProductOtherData, PostgresProductOtherDataSource } from './postgres-product-other-data-source.js';

const editMigration = [{
  id: '006_inventory_product_catalog_edit',
  sql: `CREATE TABLE tuvansa.inventory_product_catalog_edits (
    product_id bigint PRIMARY KEY CHECK (product_id BETWEEN 1 AND 9007199254740991),
    revision integer NOT NULL CHECK (revision > 0),
    changes jsonb NOT NULL CHECK (jsonb_typeof(changes) = 'object')
  );`,
}];

export async function migrateProductCatalogEdit(client: PostgresClient): Promise<void> {
  await migrateProductClassification(client);
  await migrateProductOtherData(client);
  await migratePostgres(client, editMigration);
}

const staleEdit = () => new ConflictError(
  'La ficha del producto cambió en otra sesión. Vuelve a abrirla antes de guardar.', 'PRODUCT_EDIT_STALE',
);

const readSnapshot = async (client: PostgresClient, productId: number) => {
  const result = await client.query<ProductCatalogEditSnapshot>(
    `SELECT COALESCE(e.revision, 0) AS revision, COALESCE(e.changes, '{}'::jsonb) AS changes,
      CASE WHEN c.revision IS NOT NULL THEN jsonb_build_object(
        'revision', c.revision, 'changes', c.changes, 'familyCode', c.family_code
      ) END AS classification,
      CASE WHEN o.revision IS NOT NULL THEN jsonb_build_object(
        'revision', o.revision, 'changes', o.changes,
        'changedAt', to_char(o.updated_at AT TIME ZONE 'America/Mexico_City', 'YYYY-MM-DD')
      ) END AS "otherData"
     FROM (SELECT $1::bigint AS id) AS product
     LEFT JOIN tuvansa.inventory_product_catalog_edits e ON e.product_id = product.id
     LEFT JOIN tuvansa.inventory_product_classifications c ON c.product_id = product.id
     LEFT JOIN tuvansa.inventory_product_other_data o ON o.product_id = product.id`, [productId],
  );
  return result.rows[0]!;
};

// Derivada del flujo MINV/26. Una sola transacción publica los campos que comparten las fichas.
export class PostgresProductCatalogEditDataSource implements ProductCatalogEditDataSource {
  private readonly pilotProducts: ReadonlySet<number>;

  constructor(
    products: readonly number[],
    private readonly connect: PostgresConnectionFactory = connectPostgres,
    private readonly configured: () => boolean = postgresConfigured,
  ) {
    this.pilotProducts = new Set(products);
  }

  writable(productId: number): boolean {
    return this.configured() && this.pilotProducts.has(productId);
  }

  private async connection<T>(work: (client: PostgresClient) => Promise<T>): Promise<T> {
    let client: PostgresClient | undefined;
    try {
      client = await this.connect();
      return await work(client);
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      throw new ApplicationError('No fue posible consultar la edición de inventario en PostgreSQL.', 'PRODUCT_EDIT_POSTGRES_UNAVAILABLE', 503);
    } finally {
      client?.release();
    }
  }

  get(productId: number): Promise<ProductCatalogEditSnapshot | null> {
    if (!this.writable(productId)) return Promise.resolve(null);
    return this.connection((client) => readSnapshot(client, productId));
  }

  async searchOverrides(): Promise<ReadonlyMap<number, ProductWriteValues>> {
    if (!this.configured() || !this.pilotProducts.size) return new Map();
    return this.connection(async (client) => {
      const result = await client.query<{ productId: string; changes: ProductWriteValues }>(
        `SELECT product_id AS "productId", changes FROM tuvansa.inventory_product_catalog_edits
         WHERE product_id = ANY($1::bigint[])`, [[...this.pilotProducts]],
      );
      return new Map(result.rows.map(({ productId, changes }) => [Number(productId), changes]));
    });
  }

  async save(productId: number, revision: string, changes: ProductCatalogEditChanges): Promise<ProductCatalogEditSnapshot> {
    if (!this.writable(productId)) {
      throw new ApplicationError('Este producto está fuera del piloto de edición del catálogo.', 'PRODUCT_EDIT_READ_ONLY', 403);
    }
    return this.connection(async (client) => {
      await client.query('BEGIN');
      try {
        const current = await readSnapshot(client, productId);
        if (productCatalogEditRevision(current) !== revision) throw staleEdit();

        const edits = { ...current.changes, ...changes.catalog };
        const updated = current.revision === 0
          ? await client.query(
            `INSERT INTO tuvansa.inventory_product_catalog_edits (product_id, revision, changes)
             VALUES ($1, 1, $2::jsonb) ON CONFLICT (product_id) DO NOTHING RETURNING revision`,
            [productId, JSON.stringify(edits)],
          )
          : await client.query(
            `UPDATE tuvansa.inventory_product_catalog_edits SET revision = revision + 1, changes = $2::jsonb
             WHERE product_id = $1 AND revision = $3 RETURNING revision`,
            [productId, JSON.stringify(edits), current.revision],
          );
        if (!updated.rows.length) throw staleEdit();

        const withinTransaction = async (): Promise<PostgresClient> => ({
          query: (sql, values) => client.query(sql, values),
          release() {},
        });
        const otherData = new PostgresProductOtherDataSource([productId], withinTransaction, () => true);
        await otherData.save(productId, {
          revision: current.otherData?.revision ?? 0,
          changes: { ...current.otherData?.changes, ...changes.otherData },
        });
        if (changes.familyCode !== undefined) {
          const classification = new PostgresProductClassificationDataSource([productId], withinTransaction, () => true);
          await classification.save(productId, {
            revision: current.classification?.revision ?? 0,
            changes: current.classification?.changes ?? {},
            familyCode: changes.familyCode,
          });
        }

        const saved = await readSnapshot(client, productId);
        await client.query('COMMIT');
        return saved;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    });
  }
}
