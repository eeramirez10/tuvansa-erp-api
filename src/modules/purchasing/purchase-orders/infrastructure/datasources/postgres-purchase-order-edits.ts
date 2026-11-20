import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import { ConflictError } from '../../../../../shared/domain/errors/conflict-error.js';
import {
  connectPostgres, postgresConfigured, postgresUnavailable, type PostgresClient, type PostgresConnectionFactory,
} from '../../../../../shared/infrastructure/database/postgres-pool.js';
import { migratePostgres } from '../../../../../shared/infrastructure/datasources/postgres-schema.js';
import type {
  PurchaseOrderEditSnapshot, PurchaseOrderEditStorage, PurchaseOrderStockChange,
} from '../../domain/datasources/purchase-order-edit-data-source.js';

const migrations = [{
  id: 'purchase_order_edits',
  sql: `
    CREATE SEQUENCE tuvansa.purchase_order_line_ids START WITH 6000000000000;
    CREATE TABLE tuvansa.purchase_order_edits (
      order_id bigint NOT NULL,
      order_number varchar(15) NOT NULL,
      revision integer NOT NULL CHECK (revision > 0),
      legacy_version char(64) NOT NULL,
      document jsonb NOT NULL CHECK (jsonb_typeof(document) = 'object'),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (order_id, order_number)
    );
    CREATE TABLE tuvansa.purchase_order_stock_deltas (
      order_id bigint NOT NULL,
      order_number varchar(15) NOT NULL,
      product_id bigint NOT NULL,
      pending numeric(18,3) NOT NULL,
      next_receipt_at date,
      PRIMARY KEY (order_id, order_number, product_id),
      FOREIGN KEY (order_id, order_number)
        REFERENCES tuvansa.purchase_order_edits(order_id, order_number) ON DELETE CASCADE
    );
    CREATE INDEX purchase_order_stock_product ON tuvansa.purchase_order_stock_deltas(product_id);
  `,
}];

type Stored = {
  id: string;
  number: string;
  revision: number;
  legacyVersion: string;
  document: Pick<PurchaseOrderEditSnapshot, 'lines' | 'totals' | 'amountInWords'>;
};

export class PostgresPurchaseOrderEdits implements PurchaseOrderEditStorage {
  private migration: Promise<void> | undefined;

  constructor(
    private readonly connect: PostgresConnectionFactory = connectPostgres,
    private readonly configured: () => boolean = postgresConfigured,
  ) {}

  writable() { return this.configured(); }

  private async connection<T>(work: (client: PostgresClient) => Promise<T>): Promise<T> {
    let client: PostgresClient | undefined;
    try {
      client = await this.connect();
      return await work(client);
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      throw new ApplicationError('No fue posible consultar o guardar los cambios de la orden en PostgreSQL.', 'PURCHASE_ORDER_POSTGRES_UNAVAILABLE', 503);
    } finally {
      client?.release();
    }
  }

  async find(ids: number[]): Promise<PurchaseOrderEditSnapshot[]> {
    if (!this.writable() || ids.length === 0) return [];
    return this.connection(async (client) => {
      const exists = await client.query<{ available: boolean }>(
        "SELECT to_regclass('tuvansa.purchase_order_edits') IS NOT NULL AS available",
      );
      if (!exists.rows[0]?.available) return [];
      const { rows } = await client.query<Stored>(
        `SELECT order_id AS id, order_number AS number, revision, legacy_version AS "legacyVersion", document
         FROM tuvansa.purchase_order_edits WHERE order_id = ANY($1::bigint[])`, [ids],
      );
      return rows.map(({ id, document, ...row }) => ({ ...row, id: Number(id), ...document }));
    });
  }

  async save(snapshot: PurchaseOrderEditSnapshot, stock: PurchaseOrderStockChange[]): Promise<PurchaseOrderEditSnapshot> {
    if (!this.writable()) throw postgresUnavailable();
    return this.connection(async (client) => {
      this.migration ??= migratePostgres(client, migrations).catch((error: unknown) => {
        this.migration = undefined;
        throw error;
      });
      await this.migration;
      await client.query('BEGIN');
      try {
        const missing = snapshot.lines.filter((line) => line.id === 0).length;
        const ids = missing === 0 ? [] : (await client.query<{ id: string }>(
          "SELECT nextval('tuvansa.purchase_order_line_ids') AS id FROM generate_series(1,$1::int)", [missing],
        )).rows;
        const lines = snapshot.lines.map((line) => line.id === 0 ? { ...line, id: Number(ids.shift()!.id) } : line);
        const document = { lines, totals: snapshot.totals, amountInWords: snapshot.amountInWords };
        const { id, number, legacyVersion, revision } = snapshot;
        const values = [id, number, legacyVersion, JSON.stringify(document)];
        const result = revision === 0
          ? await client.query<{ revision: number }>(
            `INSERT INTO tuvansa.purchase_order_edits(order_id, order_number, revision, legacy_version, document)
             VALUES($1,$2,1,$3,$4::jsonb) ON CONFLICT(order_id,order_number) DO NOTHING RETURNING revision`, values,
          )
          : await client.query<{ revision: number }>(
            `UPDATE tuvansa.purchase_order_edits SET document=$4::jsonb, revision=revision+1, updated_at=now()
             WHERE order_id=$1 AND order_number=$2 AND legacy_version=$3 AND revision=$5 RETURNING revision`, [...values, revision],
          );
        const saved = result.rows[0];
        if (!saved) throw new ConflictError('Otra sesión cambió la orden. Vuelve a abrir el editor.', 'PURCHASE_ORDER_EDIT_STALE');
        await this.saveStock(client, id, number, stock);
        await client.query('COMMIT');
        return { ...snapshot, ...document, revision: saved.revision };
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    });
  }

  private async saveStock(client: PostgresClient, id: number, number: string, stock: PurchaseOrderStockChange[]) {
    const { rows } = await client.query<{ productId: string; nextReceiptAt: string }>(
      `SELECT product_id AS "productId", next_receipt_at::text AS "nextReceiptAt"
       FROM tuvansa.purchase_order_stock_deltas WHERE order_id=$1 AND order_number=$2 AND next_receipt_at IS NOT NULL`, [id, number],
    );
    const changes = new Map<number, PurchaseOrderStockChange>(rows.map((row) => [
      Number(row.productId), { productId: Number(row.productId), pending: 0, nextReceiptAt: row.nextReceiptAt },
    ]));
    for (const change of stock) changes.set(change.productId, {
      ...change, nextReceiptAt: change.nextReceiptAt ?? changes.get(change.productId)?.nextReceiptAt ?? null,
    });
    await client.query('DELETE FROM tuvansa.purchase_order_stock_deltas WHERE order_id=$1 AND order_number=$2', [id, number]);
    const deltas = [...changes.values()].filter((row) => row.pending !== 0 || row.nextReceiptAt !== null);
    if (deltas.length > 0) {
      await client.query(
        `INSERT INTO tuvansa.purchase_order_stock_deltas(order_id,order_number,product_id,pending,next_receipt_at)
         SELECT $1,$2,product,pending,receipt FROM unnest($3::bigint[],$4::numeric[],$5::date[]) AS change(product,pending,receipt)`,
        [id, number, deltas.map((row) => row.productId), deltas.map((row) => row.pending), deltas.map((row) => row.nextReceiptAt)],
      );
    }
  }
}
