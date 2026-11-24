import { normalizeOrderWarehouse } from '../../domain/entities/order-warehouse.js';
import type { OrderOverlay, OrderOverlayDataSource } from '../../domain/datasources/order-overlay-data-source.js';
import type { OrderProps } from '../../domain/entities/order.js';
import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import { ConflictError } from '../../../../../shared/domain/errors/conflict-error.js';
import { NotFoundError } from '../../../../../shared/domain/errors/not-found-error.js';
import { connectPostgres, postgresConfigured, postgresUnavailable, type PostgresClient, type PostgresConnectionFactory } from '../../../../../shared/infrastructure/database/postgres-pool.js';
import { migratePostgres } from '../../../../../shared/infrastructure/datasources/postgres-schema.js';
import { assertClientCatalogCreditAllowed } from '../../../../accounts-receivable/clients/infrastructure/datasources/postgres-client-catalog.js';
import { assertActiveCatalogProducts } from '../../../../inventories/products/infrastructure/datasources/product-catalog-references.js';
import { readLegacySaleStock, verifyLocalOrderAssignment } from './sales-order-inventory-stock.js';

type Stored = { document: OrderProps; base: OrderProps | null; deleted: boolean; revision: number };
const columns = 'document,base_document AS base,(deleted_at IS NOT NULL) AS deleted,revision';

// All SQL in this datasource is DERIVADA: an independent PostgreSQL write model.
export class PostgresOrderOverlayDataSource implements OrderOverlayDataSource {
  private initialized: Promise<void> | undefined;
  constructor(private readonly connect: PostgresConnectionFactory = connectPostgres,
    private readonly isConfigured: () => boolean = postgresConfigured,
    private readonly loadStock = readLegacySaleStock) {}
  get configured() { return this.isConfigured(); }

  private async connection<T>(work: (client: PostgresClient) => Promise<T>): Promise<T> {
    if (!this.configured) throw postgresUnavailable();
    let client: PostgresClient | undefined;
    try { client = await this.connect(); return await work(client); }
    catch (error) {
      if (error instanceof ApplicationError) throw error;
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') {
        throw new ConflictError('El número de pedido ya está reservado en PostgreSQL.', 'ORDER_NUMBER_EXISTS');
      }
      // Never send/log connection strings, SQL values or server diagnostics containing credentials.
      throw new ApplicationError('No fue posible operar con PostgreSQL. Revisa la conexión y las migraciones de Neon.', 'POSTGRES_UNAVAILABLE', 503);
    } finally { client?.release(); }
  }
  async initialize() {
    if (!this.initialized) {
      this.initialized = this.connection(migratePostgres).catch(error => { this.initialized = undefined; throw error; });
    }
    await this.initialized;
  }
  private async transaction<T>(work: (client: PostgresClient) => Promise<T>): Promise<T> {
    await this.initialize();
    return this.connection(async client => {
      await client.query('BEGIN');
      try { const result = await work(client); await client.query('COMMIT'); return result; }
      catch (error) { await client.query('ROLLBACK'); throw error; }
    });
  }
  async get(id: number): Promise<OrderOverlay | null> {
    if (!this.configured) return null;
    await this.initialize();
    return this.connection(async c => (await c.query<Stored>(`SELECT ${columns} FROM tuvansa.orders WHERE id=$1`,[id])).rows[0] ?? null);
  }
  async list(): Promise<OrderOverlay[]> {
    if (!this.configured) return [];
    await this.initialize();
    return this.connection(async c => (await c.query<Stored>(`SELECT ${columns} FROM tuvansa.orders ORDER BY number,id`)).rows);
  }
  async create(build: (id: number) => Promise<OrderProps>): Promise<OrderProps> {
    return this.transaction(async c => {
      const row = (await c.query<{id:string}>("SELECT nextval('tuvansa.order_ids') AS id")).rows[0]!;
      const id = Number(row.id);
      const doc = await build(id);
      await assertClientCatalogCreditAllowed(c, doc.customer.id);
      await assertActiveCatalogProducts(c, doc.lines.map(({ productId }) => productId));
      await c.query('INSERT INTO tuvansa.orders(id,number,document) VALUES ($1,$2,$3::jsonb)', [id,doc.number,JSON.stringify(doc)]);
      await this.record(c,doc,null,false,1,'create');
      return doc;
    });
  }
  async change(id: number, base: OrderProps | null, operation: 'update' | 'delete' | 'convert' | 'assignment',
    transform: (current: OrderProps) => Promise<OrderProps | null>): Promise<OrderOverlay | null> {
    return this.transaction(async c => {
      // Locks even a missing overlay; concurrent first edits cannot race on INSERT.
      await c.query('SELECT pg_advisory_xact_lock($1::bigint)', [id]);
      let stored = (await c.query<Stored>(`SELECT ${columns} FROM tuvansa.orders WHERE id=$1 FOR UPDATE`,[id])).rows[0];
      if (!stored) {
        if (!base) return null;
        await c.query('INSERT INTO tuvansa.orders(id,legacy_id,number,document,base_document) VALUES ($1,$1,$2,$3::jsonb,$3::jsonb)', [id,base.number,JSON.stringify(base)]);
        stored = { document: base, base, deleted: false, revision: 0 };
      }
      if (stored.deleted) return null;
      const changed = await transform(structuredClone(stored.document));
      if (changed && (operation === 'convert' || (changed.authorization === 'O.K.' && stored.document.authorization !== 'O.K.')
        || (operation === 'assignment' && changed.lines.some((line) =>
          line.assigned > (stored.document.lines.find(({ id }) => id === line.id)?.assigned ?? 0))))) {
        await assertClientCatalogCreditAllowed(c, changed.customer.id);
      }
      if (changed && operation === 'update') {
        const previousProducts = new Set(stored.document.lines.map(({ productId }) => productId));
        await assertActiveCatalogProducts(c, changed.lines.map(({ productId }) => productId).filter((id) => !previousProducts.has(id)));
      }
      if (operation === 'assignment' && changed && stored.base === null) {
        await verifyLocalOrderAssignment(c, stored.document, changed, this.loadStock);
      }
      const deleted = changed === null;
      const document = changed ?? stored.document;
      const revision = stored.revision + 1;
      await c.query(`UPDATE tuvansa.orders SET document=$2::jsonb,number=$3,revision=$4,
        deleted_at=CASE WHEN $5::boolean THEN now() ELSE NULL END,updated_at=now() WHERE id=$1`,
        [id,JSON.stringify(document),document.number,revision,deleted]);
      await this.record(c,document,stored.base,deleted,revision,operation === 'assignment' ? 'update' : operation);
      return { document, base: stored.base, deleted, revision };
    });
  }

  async postRemission<T>(
    id: number,
    expectedRevision: number,
    replay: (client: PostgresClient) => Promise<T | null>,
    post: (client: PostgresClient, order: OrderProps) => Promise<{ order: OrderProps; result: T }>,
  ): Promise<T> {
    return this.transaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [id]);
      const existing = await replay(client);
      if (existing !== null) return existing;
      const { rows: [stored] } = await client.query<Stored>(
        `SELECT ${columns} FROM tuvansa.orders WHERE id=$1 AND legacy_id IS NULL FOR UPDATE`, [id],
      );
      if (!stored || stored.deleted) throw new NotFoundError('Pedido local');
      if (stored.revision !== expectedRevision) {
        throw new ConflictError('El pedido cambió. Vuelve a abrir la remisión.', 'SALES_REMISSION_ORDER_CHANGED');
      }
      const { order, result } = await post(client, stored.document);
      await this.updateRemissionOrder(client, stored, order);
      return result;
    });
  }

  async cancelRemission<T>(orderId: number | null, replay: (client: PostgresClient) => Promise<T | null>,
    cancel: (client: PostgresClient, current: OrderProps | null) => Promise<{ order: OrderProps | null; result: T }>,
    legacyOrder?: OrderProps): Promise<T> {
    return this.transaction(async (client) => {
      if (orderId !== null) await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [orderId]);
      const existing = await replay(client);
      if (existing !== null) return existing;
      const { rows: [stored] } = orderId === null ? { rows: [] } : await client.query<Stored & { sameBase: boolean | null }>(
        `SELECT ${columns},base_document=$2::jsonb AS "sameBase" FROM tuvansa.orders WHERE id=$1 FOR UPDATE`,
        [orderId, legacyOrder ? JSON.stringify(legacyOrder) : null],
      );
      if (legacyOrder) {
        if (legacyOrder.id !== orderId || (stored && (stored.deleted || !stored.sameBase))) {
          throw new ConflictError('El pedido original cambió o fue dado de baja.', 'SALES_REMISSION_ORDER_CHANGED');
        }
      } else if (orderId !== null && (!stored || stored.deleted || stored.base !== null)) {
        throw new NotFoundError('Pedido local para regenerar');
      }
      const { order, result } = await cancel(client, stored?.document ?? legacyOrder ?? null);
      if (order && stored) {
        await this.updateRemissionOrder(client, stored, order);
      } else if (order && legacyOrder) {
        await client.query(`INSERT INTO tuvansa.orders(id,legacy_id,number,document,base_document)
          VALUES ($1,$1,$2,$3::jsonb,$4::jsonb)`, [order.id, order.number, JSON.stringify(order), JSON.stringify(legacyOrder)]);
        await this.record(client, order, legacyOrder, false, 1, 'update');
      }
      return result;
    });
  }

  private async updateRemissionOrder(client: PostgresClient, stored: Stored, order: OrderProps) {
    if (order.id !== stored.document.id || order.number !== stored.document.number) {
      throw new ConflictError('La remisión no coincide con el pedido.', 'SALES_REMISSION_ORDER_MISMATCH');
    }
    const nextRevision = stored.revision + 1;
    await client.query('UPDATE tuvansa.orders SET document=$2::jsonb,revision=$3,updated_at=now() WHERE id=$1',
      [order.id, JSON.stringify(order), nextRevision]);
    await this.record(client, order, stored.base, false, nextRevision, 'update');
  }
  private async record(c: PostgresClient, doc: OrderProps, base: OrderProps | null, deleted: boolean, revision: number, operation: string) {
    await c.query('INSERT INTO tuvansa.order_changes(order_id,revision,operation,document) VALUES ($1,$2,$3,$4::jsonb)', [doc.id,revision,operation,JSON.stringify(doc)]);
    await c.query('DELETE FROM tuvansa.order_stock_deltas WHERE order_id=$1', [doc.id]);
    const deltas = new Map<string,{productId:number;warehouse:string;ordered:number;quoted:number}>();
    const add = (order: OrderProps, sign: number) => {
      const warehouse = normalizeOrderWarehouse(order.warehouse);
      for (const line of order.lines) {
        const key = `${line.productId}:${warehouse}`;
        const value = deltas.get(key) ?? {productId:line.productId,warehouse,ordered:0,quoted:0};
        const pending = Math.max(line.ordered-line.fulfilled,0) * sign;
        if (order.documentKind === 'order') value.ordered += pending;
        if (order.documentKind === 'quote') value.quoted += pending;
        deltas.set(key,value);
      }
    };
    if (base) add(base,-1);
    if (!deleted) add(doc,1);
    for (const delta of deltas.values()) {
      await c.query('INSERT INTO tuvansa.order_stock_deltas(order_id,product_id,warehouse,ordered,quoted) VALUES ($1,$2,$3,$4,$5)',
        [doc.id,delta.productId,delta.warehouse,delta.ordered,delta.quoted]);
    }
  }
}
