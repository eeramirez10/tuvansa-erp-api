import type { OrderOverlay, OrderOverlayDataSource } from '../../domain/datasources/order-overlay-data-source.js';
import type { OrderProps } from '../../domain/entities/order.js';
import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import { ConflictError } from '../../../../../shared/domain/errors/conflict-error.js';
import { connectPostgres, postgresConfigured, postgresUnavailable, type PostgresClient, type PostgresConnectionFactory } from '../../../../../shared/infrastructure/database/postgres-pool.js';
import { migratePostgres } from '../../../../../shared/infrastructure/datasources/postgres-schema.js';

type Stored = { document: OrderProps; base: OrderProps | null; deleted: boolean; revision: number };
const columns = 'document,base_document AS base,(deleted_at IS NOT NULL) AS deleted,revision';

// All SQL in this datasource is DERIVADA: an independent PostgreSQL write model.
export class PostgresOrderOverlayDataSource implements OrderOverlayDataSource {
  private initialized: Promise<void> | undefined;
  constructor(private readonly connect: PostgresConnectionFactory = connectPostgres,
    private readonly isConfigured: () => boolean = postgresConfigured) {}
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
      await c.query('INSERT INTO tuvansa.orders(id,number,document) VALUES ($1,$2,$3::jsonb)', [id,doc.number,JSON.stringify(doc)]);
      await this.record(c,doc,null,false,1,'create');
      return doc;
    });
  }
  async change(id: number, base: OrderProps | null, operation: 'update' | 'delete' | 'convert',
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
      const deleted = changed === null;
      const document = changed ?? stored.document;
      const revision = stored.revision + 1;
      await c.query(`UPDATE tuvansa.orders SET document=$2::jsonb,number=$3,revision=$4,
        deleted_at=CASE WHEN $5::boolean THEN now() ELSE NULL END,updated_at=now() WHERE id=$1`,
        [id,JSON.stringify(document),document.number,revision,deleted]);
      await this.record(c,document,stored.base,deleted,revision,operation);
      return { document, base: stored.base, deleted, revision };
    });
  }
  private async record(c: PostgresClient, doc: OrderProps, base: OrderProps | null, deleted: boolean, revision: number, operation: string) {
    await c.query('INSERT INTO tuvansa.order_changes(order_id,revision,operation,document) VALUES ($1,$2,$3,$4::jsonb)', [doc.id,revision,operation,JSON.stringify(doc)]);
    await c.query('DELETE FROM tuvansa.order_stock_deltas WHERE order_id=$1', [doc.id]);
    const deltas = new Map<string,{productId:number;warehouse:string;ordered:number;quoted:number}>();
    const add = (order: OrderProps, sign: number) => {
      for (const line of order.lines) {
        const key = `${line.productId}:${order.warehouse}`;
        const value = deltas.get(key) ?? {productId:line.productId,warehouse:order.warehouse,ordered:0,quoted:0};
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
