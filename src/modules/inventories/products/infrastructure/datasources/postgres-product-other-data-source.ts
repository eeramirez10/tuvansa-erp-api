import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import { ConflictError } from '../../../../../shared/domain/errors/conflict-error.js';
import {
  connectPostgres,
  postgresConfigured,
  type PostgresClient,
  type PostgresConnectionFactory,
} from '../../../../../shared/infrastructure/database/postgres-pool.js';
import { migratePostgres } from '../../../../../shared/infrastructure/datasources/postgres-schema.js';
import type { ProductOtherDataStorageDataSource } from '../../domain/datasources/product-other-data-source.js';
import type { StoredProductOtherData } from '../../domain/repositories/product-other-data-repository.js';

const productOtherDataMigrations = [{
  id: '005_inventory_product_other_data',
  sql: `CREATE TABLE tuvansa.inventory_product_other_data (
    product_id bigint PRIMARY KEY CHECK (product_id BETWEEN 1 AND 9007199254740991),
    revision integer NOT NULL CHECK (revision > 0),
    changes jsonb NOT NULL CHECK (jsonb_typeof(changes) = 'object'),
    updated_at timestamptz NOT NULL DEFAULT now()
  );`,
}];

const resultColumns = `revision, changes, to_char(updated_at AT TIME ZONE 'America/Mexico_City', 'YYYY-MM-DD') AS "changedAt"`;

export const migrateProductOtherData = (client: PostgresClient) =>
  migratePostgres(client, productOtherDataMigrations);

// Derivada. PostgreSQL guarda los campos cambiados sobre el catálogo legado.
export class PostgresProductOtherDataSource implements ProductOtherDataStorageDataSource {
  private readonly pilotProducts: ReadonlySet<number>;
  private readonly readableProducts: ReadonlySet<number>;

  constructor(
    products: readonly number[],
    private readonly connect: PostgresConnectionFactory = connectPostgres,
    private readonly configured: () => boolean = postgresConfigured,
    readableProducts: readonly number[] = [],
  ) {
    this.pilotProducts = new Set(products);
    this.readableProducts = new Set([...products, ...readableProducts]);
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
      throw new ApplicationError('No fue posible consultar Otros en PostgreSQL.', 'OTHER_DATA_POSTGRES_UNAVAILABLE', 503);
    } finally {
      client?.release();
    }
  }

  async get(productId: number): Promise<StoredProductOtherData | null> {
    if (!this.configured() || !this.readableProducts.has(productId)) return null;
    return this.connection(async (client) => {
      const { rows } = await client.query<StoredProductOtherData>(
        `SELECT ${resultColumns} FROM tuvansa.inventory_product_other_data WHERE product_id = $1`, [productId],
      );
      return rows[0] ?? null;
    });
  }

  async save(productId: number, { revision, changes }: StoredProductOtherData): Promise<StoredProductOtherData> {
    if (!this.writable(productId)) {
      throw new ApplicationError('Este producto está fuera del piloto de Otros en PostgreSQL.', 'OTHER_DATA_READ_ONLY', 403);
    }
    return this.connection(async (client) => {
      const sql = revision === 0
        ? `INSERT INTO tuvansa.inventory_product_other_data (product_id, revision, changes)
           VALUES ($1, 1, $2::jsonb) ON CONFLICT (product_id) DO NOTHING RETURNING ${resultColumns}`
        : `UPDATE tuvansa.inventory_product_other_data
           SET changes = $2::jsonb, revision = revision + 1, updated_at = now()
           WHERE product_id = $1 AND revision = $3 RETURNING ${resultColumns}`;
      const values: unknown[] = [productId, JSON.stringify(changes)];
      if (revision !== 0) values.push(revision);
      const result = (await client.query<StoredProductOtherData>(sql, values)).rows[0];
      if (!result) throw new ConflictError('Los datos de Otros cambiaron en otra sesión. Vuelve a cargar la ventana.', 'OTHER_DATA_STALE');
      return result;
    });
  }
}
