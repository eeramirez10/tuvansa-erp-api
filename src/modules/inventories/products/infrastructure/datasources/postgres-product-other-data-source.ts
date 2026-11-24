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
import type { ProductWriteValues } from '../../domain/repositories/products-repository.js';
import type { ProductOtherDataValues } from '../../domain/entities/product-other-data.js';
import { catalogProductsById } from './product-catalog-references.js';
import { applyProductWriteValues } from './product-catalog-record.js';
import { productCatalogTransaction } from './postgres-product-catalog-snapshot.js';

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

const sharedFields = new Set(['location', 'list4', 'list5', 'list6', 'currency6']);
const sharedValues = (values: ProductOtherDataValues): ProductWriteValues => ({
  ...(typeof values.location === 'string' ? { location: values.location } : {}),
  ...(typeof values.list4 === 'number' ? { averageCost: values.list4 } : {}),
  ...(typeof values.list5 === 'number' ? { lastCost: values.list5 } : {}),
  ...(typeof values.list6 === 'number' ? { previousCost: values.list6 } : {}),
  ...(typeof values.currency6 === 'number' ? { costCurrency: values.currency6 } : {}),
});

// Derivada. PostgreSQL guarda los campos cambiados sobre el catálogo legado.
export class PostgresProductOtherDataSource implements ProductOtherDataStorageDataSource {
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
      throw new ApplicationError('No fue posible consultar Otros en PostgreSQL.', 'OTHER_DATA_POSTGRES_UNAVAILABLE', 503);
    } finally {
      client?.release();
    }
  }

  async get(productId: number): Promise<StoredProductOtherData | null> {
    if (!this.configured() || (!this.readableProducts.has(productId) && !await this.writable(productId))) return null;
    return this.connection(async (client) => {
      const { rows } = await client.query<StoredProductOtherData>(
        `SELECT ${resultColumns} FROM tuvansa.inventory_product_other_data WHERE product_id = $1`, [productId],
      );
      const result = rows[0];
      const current = this.staged && result ? (await catalogProductsById([productId], client)).get(productId) : undefined;
      return current && result ? {
        ...result, changes: Object.fromEntries(Object.entries(result.changes).filter(([field]) => !sharedFields.has(field))),
      } : result ?? null;
    });
  }

  async save(productId: number, { revision, changes }: StoredProductOtherData): Promise<StoredProductOtherData> {
    if (!await this.writable(productId)) {
      throw new ApplicationError('Este producto está fuera del piloto de Otros en PostgreSQL.', 'OTHER_DATA_READ_ONLY', 403);
    }
    const store = async (client: PostgresClient) => {
      const current = this.staged ? (await catalogProductsById([productId], client)).get(productId) : undefined;
      if (current?.deleted) throw new ConflictError('El producto está dado de baja.', 'PRODUCT_NOT_ACTIVE');
      const sql = revision === 0
        ? `INSERT INTO tuvansa.inventory_product_other_data (product_id, revision, changes)
           VALUES ($1, 1, $2::jsonb) ON CONFLICT (product_id) DO NOTHING RETURNING ${resultColumns}`
        : `UPDATE tuvansa.inventory_product_other_data
           SET changes = $2::jsonb, revision = revision + 1, updated_at = now()
           WHERE product_id = $1 AND revision = $3 RETURNING ${resultColumns}`;
      const persisted = current ? Object.fromEntries(Object.entries(changes).filter(([field]) => !sharedFields.has(field))) : changes;
      const values: unknown[] = [productId, JSON.stringify(persisted)];
      if (revision !== 0) values.push(revision);
      const result = (await client.query<StoredProductOtherData>(sql, values)).rows[0];
      if (!result) throw new ConflictError('Los datos de Otros cambiaron en otra sesión. Vuelve a cargar la ventana.', 'OTHER_DATA_STALE');
      if (current) {
        const updates = sharedValues(changes);
        if (Object.keys(updates).length) {
          await client.query(
            'UPDATE tuvansa.inventory_products SET document=$2,revision=revision+1 WHERE id=$1 AND deleted_at IS NULL',
            [productId, applyProductWriteValues(current.document, updates)],
          );
        }
      }
      return { ...result, changes };
    };
    return this.staged ? productCatalogTransaction(this.connect, store) : this.connection(store);
  }
}
