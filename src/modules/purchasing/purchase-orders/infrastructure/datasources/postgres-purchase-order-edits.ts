import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import { ConflictError } from '../../../../../shared/domain/errors/conflict-error.js';
import {
  connectPostgres, postgresConfigured, postgresUnavailable, type PostgresClient, type PostgresConnectionFactory,
} from '../../../../../shared/infrastructure/database/postgres-pool.js';
import { migratePostgres } from '../../../../../shared/infrastructure/datasources/postgres-schema.js';
import type {
  PurchaseOrderEditSnapshot, PurchaseOrderEditStorage, PurchaseOrderStockChange,
} from '../../domain/datasources/purchase-order-edit-data-source.js';
import {
  isLocalPurchaseOrderId, localPurchaseOrderIdStart, localPurchaseOrderNumber,
  type LocalPurchaseOrder, type NewPurchaseOrder, type PurchaseOrderCreateStorage, type PurchaseOrderLocalMetadata,
} from '../../domain/datasources/purchase-order-create-data-source.js';
import { PurchaseOrder, type PurchaseOrderLine } from '../../domain/entities/purchase-order.js';
import type { PurchaseOrderIdentity, PurchaseOrderNavigationDirection, PurchaseOrderSearchCriteria, PurchaseOrderSearchResult } from '../../domain/repositories/purchase-orders-repository.js';

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
}, {
  id: 'purchase_order_creation',
  sql: `
    CREATE SEQUENCE tuvansa.purchase_order_ids START WITH ${localPurchaseOrderIdStart} MAXVALUE ${localPurchaseOrderIdStart + 99999998};
    CREATE TABLE tuvansa.purchase_orders (
      id bigint PRIMARY KEY,
      number varchar(15) UNIQUE NOT NULL,
      request_key uuid UNIQUE NOT NULL,
      fingerprint char(64) NOT NULL,
      header jsonb NOT NULL CHECK (jsonb_typeof(header) = 'object'),
      metadata jsonb NOT NULL CHECK (jsonb_typeof(metadata) = 'object'),
      FOREIGN KEY (id, number) REFERENCES tuvansa.purchase_order_edits(order_id, order_number)
    );
  `,
}];

type Stored = {
  id: string;
  number: string;
  revision: number;
  legacyVersion: string;
  document: Pick<PurchaseOrderEditSnapshot, 'lines' | 'totals' | 'amountInWords'>;
};

type LocalRow = { id: string; number: string; fingerprint: string; header: NewPurchaseOrder['header']; metadata: PurchaseOrderLocalMetadata };
const asOrder = ({ id, number, header }: LocalRow) => PurchaseOrder.create({ ...header, id: Number(id), number });
const requestConflict = () => new ConflictError('La clave de alta ya se usó para una orden con otros datos.', 'PURCHASE_ORDER_REQUEST_CONFLICT');

export class PostgresPurchaseOrderEdits implements PurchaseOrderEditStorage, PurchaseOrderCreateStorage {
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

  private async transaction<T>(work: (client: PostgresClient) => Promise<T>): Promise<T> {
    if (!this.writable()) throw postgresUnavailable();
    return this.connection(async (client) => {
      this.migration ??= migratePostgres(client, migrations).catch((error: unknown) => {
        this.migration = undefined;
        throw error;
      });
      await this.migration;
      await client.query('BEGIN');
      try {
        const saved = await work(client);
        await client.query('COMMIT');
        return saved;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    });
  }

  private async readLocal<T>(empty: T, work: (client: PostgresClient) => Promise<T>): Promise<T> {
    if (!this.writable()) return empty;
    return this.connection(async (client) => {
      const { rows } = await client.query<{ available: boolean }>(
        "SELECT to_regclass('tuvansa.purchase_orders') IS NOT NULL AS available",
      );
      return rows[0]?.available ? work(client) : empty;
    });
  }

  private async localRecord(where: 'id' | 'number', value: string | number): Promise<LocalPurchaseOrder | null> {
    return this.readLocal<LocalPurchaseOrder | null>(null, async (client) => {
      const { rows } = await client.query<LocalRow>(
        `SELECT id, number, header, metadata, fingerprint FROM tuvansa.purchase_orders WHERE ${where}=$1`, [value],
      );
      const row = rows[0];
      return row ? { order: asOrder(row), metadata: row.metadata, fingerprint: row.fingerprint } : null;
    });
  }

  findLocal(id: number) {
    return isLocalPurchaseOrderId(id) ? this.localRecord('id', id) : Promise.resolve(null);
  }

  findLocalByNumber(number: string) {
    const normalized = number.toUpperCase();
    return localPurchaseOrderNumber.test(normalized) ? this.localRecord('number', normalized) : Promise.resolve(null);
  }

  private async byRequest(client: PostgresClient, requestKey: string, fingerprint: string): Promise<PurchaseOrderIdentity | null> {
    const { rows } = await client.query<Pick<LocalRow, 'id' | 'number' | 'fingerprint'>>(
      'SELECT id, number, fingerprint FROM tuvansa.purchase_orders WHERE request_key=$1', [requestKey],
    );
    const found = rows[0];
    if (!found) return null;
    if (found.fingerprint !== fingerprint) throw requestConflict();
    return { id: Number(found.id), number: found.number };
  }

  findLocalRequest(requestKey: string, fingerprint: string) {
    return this.readLocal<PurchaseOrderIdentity | null>(null, (client) => this.byRequest(client, requestKey, fingerprint));
  }

  async searchLocal(criteria: PurchaseOrderSearchCriteria, excluded: PurchaseOrderIdentity[], matching: PurchaseOrderIdentity[]): Promise<PurchaseOrderSearchResult> {
    const empty = { items: [], total: 0 };
    if (criteria.documentType === 5) return empty;
    return this.readLocal<PurchaseOrderSearchResult>(empty, async (client) => {
      const values: unknown[] = [];
      const param = (value: unknown) => `$${values.push(value)}`;
      const conditions: string[] = [];
      const orderNumber = criteria.orderNumber;
      if (orderNumber !== undefined) conditions.push(`number ILIKE ${param(orderNumber + '%')}`);
      if (criteria.query !== undefined) {
        const variable = param('%' + criteria.query + '%');
        conditions.push(`(number ILIKE ${variable} OR header->>'supplierOrderNumber' ILIKE ${variable}
          OR header#>>'{supplier,code}' ILIKE ${variable} OR header#>>'{supplier,name}' ILIKE ${variable})`);
      }
      if (criteria.supplierOrderNumber !== undefined) conditions.push(`header->>'supplierOrderNumber' ILIKE ${param(criteria.supplierOrderNumber + '%')}`);
      if (criteria.supplierCode !== undefined) conditions.push(`header#>>'{supplier,code}' ILIKE ${param(criteria.supplierCode + '%')}`);
      if (criteria.orderedAt !== undefined) conditions.push(`header#>>'{dates,orderedAt}' = ${param(criteria.orderedAt)}`);
      if (criteria.dueAt !== undefined) conditions.push(`header#>>'{dates,dueAt}' = ${param(criteria.dueAt)}`);
      if (criteria.agent !== undefined) {
        const isOriginal = `header#>>'{classifications,0}' ILIKE ${param(criteria.agent + '%')}`;
        const withoutOverrides = excluded.length === 0 ? isOriginal
          : `(${isOriginal} AND NOT (id=ANY(${param(excluded.map(({ id }) => id))}::bigint[])))`;
        conditions.push(matching.length === 0 ? withoutOverrides
          : `(${withoutOverrides} OR id=ANY(${param(matching.map(({ id }) => id))}::bigint[]))`);
      }
      const where = conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`;
      const { rows } = await client.query<LocalRow & { total: string }>(
        `SELECT id, number, header, count(*) OVER () AS total FROM tuvansa.purchase_orders ${where}
         ORDER BY number COLLATE "C", id LIMIT ${param(criteria.offset + criteria.limit)}`, values,
      );
      return { items: rows.map(asOrder), total: Number(rows[0]?.total ?? 0) };
    });
  }

  findLocalAdjacent(number: string, direction: PurchaseOrderNavigationDirection) {
    return this.readLocal<PurchaseOrder | null>(null, async (client) => {
      const comparison = direction === 'previous' ? '<' : '>';
      const order = direction === 'previous' ? 'DESC' : 'ASC';
      const { rows } = await client.query<LocalRow>(
        `SELECT id, number, header FROM tuvansa.purchase_orders WHERE number ${comparison} $1
         ORDER BY number COLLATE "C" ${order} LIMIT 1`, [number],
      );
      return rows[0] ? asOrder(rows[0]) : null;
    });
  }

  async create(requestKey: string, fingerprint: string, order: NewPurchaseOrder): Promise<PurchaseOrderIdentity> {
    return this.transaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))', [requestKey]);
      const prior = await this.byRequest(client, requestKey, fingerprint);
      if (prior) return prior;
      const allocation = (await client.query<{ id: string }>("SELECT nextval('tuvansa.purchase_order_ids') AS id")).rows[0]!;
      const id = Number(allocation.id);
      const number = `OW${String(id - localPurchaseOrderIdStart + 1).padStart(8, '0')}`;
      const lines = await this.allocateLineIds(client, order.document.lines);
      await client.query(
        `INSERT INTO tuvansa.purchase_order_edits(order_id, order_number, revision, legacy_version, document)
         VALUES($1,$2,1,$3,$4::jsonb)`, [id, number, fingerprint, JSON.stringify({ ...order.document, lines })],
      );
      await client.query(
        `INSERT INTO tuvansa.purchase_orders(id, number, request_key, fingerprint, header, metadata)
         VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb)`,
        [id, number, requestKey, fingerprint, JSON.stringify(order.header), JSON.stringify(order.metadata)],
      );
      await this.saveStock(client, id, number, order.stock);
      return { id, number };
    });
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
    return this.transaction(async (client) => {
      const lines = await this.allocateLineIds(client, snapshot.lines);
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
      return { ...snapshot, ...document, revision: saved.revision };
    });
  }

  private async allocateLineIds(client: PostgresClient, lines: PurchaseOrderLine[]) {
    const missing = lines.filter((line) => line.id === 0).length;
    if (missing === 0) return lines;
    const { rows } = await client.query<{ id: string }>(
      "SELECT nextval('tuvansa.purchase_order_line_ids') AS id FROM generate_series(1,$1::int)", [missing],
    );
    let index = 0;
    return lines.map((line) => line.id === 0 ? { ...line, id: Number(rows[index++]!.id) } : line);
  }

  private async saveStock(client: PostgresClient, id: number, number: string, stock: PurchaseOrderStockChange[]) {
    const { rows } = isLocalPurchaseOrderId(id) ? { rows: [] } : await client.query<{ productId: string; nextReceiptAt: string }>(
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
