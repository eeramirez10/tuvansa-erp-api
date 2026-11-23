import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import { ConflictError } from '../../../../../shared/domain/errors/conflict-error.js';
import {
  connectPostgres, postgresConfigured, postgresUnavailable,
  type PostgresClient, type PostgresConnectionFactory,
} from '../../../../../shared/infrastructure/database/postgres-pool.js';
import { migratePostgres } from '../../../../../shared/infrastructure/datasources/postgres-schema.js';
import { assertActivePurchaseOrder, lockPurchaseOrderWrite } from '../../../../../shared/infrastructure/datasources/postgres-purchase-order-removals.js';
import type { PurchaseOrderAgentOverride, PurchaseOrderClassificationStorage } from '../../domain/datasources/purchase-orders-data-source.js';
import type {
  PurchaseOrderClassificationUpdate, PurchaseOrderIdentity, SavedPurchaseOrderClassifications,
} from '../../domain/repositories/purchase-orders-repository.js';

const migrations = [{
  id: 'purchase_order_classifications',
  sql: `CREATE TABLE tuvansa.purchase_order_classifications (
    order_id bigint NOT NULL CHECK (order_id BETWEEN 1 AND 9007199254740991),
    order_number varchar(15) NOT NULL,
    current_values jsonb NOT NULL CHECK (jsonb_typeof(current_values) = 'array' AND jsonb_array_length(current_values) = 9),
    revision integer NOT NULL CHECK (revision > 0),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (order_id, order_number)
  );`,
}];

export class PostgresPurchaseOrderClassifications implements PurchaseOrderClassificationStorage {
  private migration: Promise<void> | undefined;

  constructor(
    private readonly connect: PostgresConnectionFactory = connectPostgres,
    private readonly configured: () => boolean = postgresConfigured,
  ) {}

  writable(): boolean { return this.configured(); }

  private async connection<T>(work: (client: PostgresClient) => Promise<T>): Promise<T> {
    let client: PostgresClient | undefined;
    try {
      client = await this.connect();
      return await work(client);
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      throw new ApplicationError(
        'No fue posible consultar o guardar la clasificación de la orden en PostgreSQL.',
        'PURCHASE_ORDER_CLASSIFICATIONS_POSTGRES_UNAVAILABLE', 503,
      );
    } finally {
      client?.release();
    }
  }

  private async existingTable<T extends object>(sql: string, values: unknown[]): Promise<T[]> {
    if (!this.configured()) return [];
    return this.connection(async (client) => {
      const { rows } = await client.query<{ available: boolean }>(
        "SELECT to_regclass('tuvansa.purchase_order_classifications') IS NOT NULL AS available",
      );
      return rows[0]?.available ? (await client.query<T>(sql, values)).rows : [];
    });
  }

  async find(ids: number[]): Promise<SavedPurchaseOrderClassifications[]> {
    if (ids.length === 0) return [];
    const rows = await this.existingTable<SavedPurchaseOrderClassifications>(
      `SELECT order_id AS id, order_number AS number, current_values AS current, revision
       FROM tuvansa.purchase_order_classifications WHERE order_id = ANY($1::bigint[])`, [ids],
    );
    return rows.map((row) => ({ ...row, id: Number(row.id) }));
  }

  async agentOverrides(prefix: string): Promise<PurchaseOrderAgentOverride[]> {
    const rows = await this.existingTable<PurchaseOrderAgentOverride>(
      `SELECT order_id AS id, order_number AS number, (current_values->>0) ILIKE $1 AS matches
       FROM tuvansa.purchase_order_classifications`, [`${prefix}%`],
    );
    return rows.map((row) => ({ ...row, id: Number(row.id) }));
  }

  async save(order: PurchaseOrderIdentity, update: PurchaseOrderClassificationUpdate): Promise<SavedPurchaseOrderClassifications> {
    if (!this.writable()) throw postgresUnavailable();
    return this.connection(async (client) => {
      this.migration ??= migratePostgres(client, migrations).catch((error: unknown) => {
        this.migration = undefined;
        throw error;
      });
      await this.migration;

      await client.query('BEGIN');
      try {
        await lockPurchaseOrderWrite(client, order.id);
        await assertActivePurchaseOrder(client, order);
        const values = [order.id, order.number, JSON.stringify(update.current)];
        const returning = 'RETURNING current_values AS current, revision';
        const { rows } = update.revision === 0
          ? await client.query<PurchaseOrderClassificationUpdate>(
            `INSERT INTO tuvansa.purchase_order_classifications (order_id, order_number, current_values, revision)
             VALUES ($1, $2, $3::jsonb, 1) ON CONFLICT (order_id, order_number) DO NOTHING ${returning}`, values,
          )
          : await client.query<PurchaseOrderClassificationUpdate>(
            `UPDATE tuvansa.purchase_order_classifications
             SET current_values = $3::jsonb, revision = revision + 1, updated_at = now()
             WHERE order_id = $1 AND order_number = $2 AND revision = $4 ${returning}`, [...values, update.revision],
          );
        if (!rows[0]) {
          throw new ConflictError('Otra sesión cambió la clasificación. Vuelve a abrir la ventana.', 'PURCHASE_ORDER_CLASSIFICATIONS_STALE');
        }
        await client.query('COMMIT');
        return { ...order, ...rows[0] };
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    });
  }
}
