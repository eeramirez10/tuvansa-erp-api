import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import { ConflictError } from '../../../../../shared/domain/errors/conflict-error.js';
import {
  connectPostgres,
  postgresConfigured,
  type PostgresConnectionFactory,
  type PostgresClient,
} from '../../../../../shared/infrastructure/database/postgres-pool.js';
import { migratePostgres } from '../../../../../shared/infrastructure/datasources/postgres-schema.js';
import type { ProductClassificationStorageDataSource } from '../../domain/datasources/product-classification-data-source.js';
import type { StoredProductClassification } from '../../domain/repositories/product-classification-repository.js';
import { productCatalogTransaction } from './postgres-product-catalog-snapshot.js';
import { catalogProductsById } from './product-catalog-references.js';

const productClassificationMigrations = [{
  id: '004_inventory_product_classification',
  sql: `CREATE TABLE tuvansa.inventory_product_classifications (
    product_id bigint PRIMARY KEY CHECK (product_id BETWEEN 1 AND 9007199254740991),
    revision integer NOT NULL CHECK (revision > 0),
    changes jsonb NOT NULL CHECK (jsonb_typeof(changes) = 'object'),
    family_code varchar(16),
    updated_at timestamptz NOT NULL DEFAULT now()
  );`,
}];

export const migrateProductClassification = (client: PostgresClient) =>
  migratePostgres(client, productClassificationMigrations);

// Derivada. Guarda únicamente las decisiones del piloto y su revisión.
export class PostgresProductClassificationDataSource implements ProductClassificationStorageDataSource {
  private readonly pilotProducts: ReadonlySet<number>;
  private readonly readableProducts: ReadonlySet<number>;

  constructor(
    products: readonly number[],
    private readonly connect: PostgresConnectionFactory = connectPostgres,
    private readonly configured: () => boolean = postgresConfigured,
    readableProducts: readonly number[] = [],
    private readonly staged = false,
  ) {
    this.pilotProducts = new Set(products);
    this.readableProducts = new Set([...products, ...readableProducts]);
  }

  writable(productId: number) {
    if (!this.configured()) return false;
    if (!this.staged) return this.pilotProducts.has(productId);
    return catalogProductsById([productId]).then((records) => {
      const product = records.get(productId);
      return product ? !product.deleted : this.pilotProducts.has(productId);
    });
  }

  private async connection<T>(work: (client: PostgresClient) => Promise<T>): Promise<T> {
    let client: PostgresClient | undefined;
    try {
      client = await this.connect();
      return await work(client);
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      throw new ApplicationError('No fue posible consultar la clasificación en PostgreSQL.', 'CLASSIFICATION_POSTGRES_UNAVAILABLE', 503);
    } finally {
      client?.release();
    }
  }

  async get(productId: number): Promise<StoredProductClassification | null> {
    if (!this.configured() || (!this.readableProducts.has(productId) && !await this.writable(productId))) return null;
    return this.connection(async (client) => {
      const { rows } = await client.query<StoredProductClassification>(
        `SELECT revision, changes, family_code AS "familyCode"
         FROM tuvansa.inventory_product_classifications WHERE product_id = $1`, [productId],
      );
      const result = rows[0];
      const current = this.staged && result ? (await catalogProductsById([productId], client)).get(productId) : undefined;
      return current && result ? { ...result, familyCode: current.document.classification.familyCode } : result ?? null;
    });
  }

  async save(productId: number, { revision, changes, familyCode }: StoredProductClassification): Promise<StoredProductClassification> {
    if (!await this.writable(productId)) {
      throw new ApplicationError('Este producto está fuera del piloto de clasificación en PostgreSQL.', 'CLASSIFICATION_READ_ONLY', 403);
    }
    const store = async (client: PostgresClient) => {
      const current = this.staged ? (await catalogProductsById([productId], client)).get(productId) : undefined;
      if (current?.deleted) throw new ConflictError('El producto está dado de baja.', 'PRODUCT_NOT_ACTIVE');
      const sql = revision === 0
        ? `INSERT INTO tuvansa.inventory_product_classifications (product_id, revision, changes, family_code)
           VALUES ($1, 1, $2::jsonb, $3) ON CONFLICT (product_id) DO NOTHING
           RETURNING revision, changes, family_code AS "familyCode"`
        : `UPDATE tuvansa.inventory_product_classifications
           SET changes = $2::jsonb, family_code = $3, revision = revision + 1, updated_at = now()
           WHERE product_id = $1 AND revision = $4 RETURNING revision, changes, family_code AS "familyCode"`;
      const values: unknown[] = [productId, JSON.stringify(changes), familyCode];
      if (revision !== 0) values.push(revision);
      const result = (await client.query<StoredProductClassification>(sql, values)).rows[0];
      if (!result) throw new ConflictError('La clasificación cambió en otra sesión. Vuelve a abrir la ventana.', 'CLASSIFICATION_STALE');
      if (current && familyCode !== null && familyCode !== current.document.classification.familyCode) {
        await client.query(
          `UPDATE tuvansa.inventory_products
           SET document=jsonb_set(document,'{classification,familyCode}',to_jsonb($2::text)),revision=revision+1
           WHERE id=$1 AND deleted_at IS NULL`, [productId, familyCode],
        );
      }
      return result;
    };
    return this.staged ? productCatalogTransaction(this.connect, store) : this.connection(store);
  }
}
