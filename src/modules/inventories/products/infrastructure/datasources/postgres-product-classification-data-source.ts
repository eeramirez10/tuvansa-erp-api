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

  constructor(
    products: readonly number[],
    private readonly connect: PostgresConnectionFactory = connectPostgres,
    private readonly configured: () => boolean = postgresConfigured,
  ) {
    this.pilotProducts = new Set(products);
  }

  writable(productId: number) {
    return this.configured() && this.pilotProducts.has(productId);
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
    if (!this.writable(productId)) return null;
    return this.connection(async (client) => {
      const { rows } = await client.query<StoredProductClassification>(
        `SELECT revision, changes, family_code AS "familyCode"
         FROM tuvansa.inventory_product_classifications WHERE product_id = $1`, [productId],
      );
      return rows[0] ?? null;
    });
  }

  async save(productId: number, { revision, changes, familyCode }: StoredProductClassification): Promise<StoredProductClassification> {
    if (!this.writable(productId)) {
      throw new ApplicationError('Este producto está fuera del piloto de clasificación en PostgreSQL.', 'CLASSIFICATION_READ_ONLY', 403);
    }
    return this.connection(async (client) => {
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
      return result;
    });
  }
}
