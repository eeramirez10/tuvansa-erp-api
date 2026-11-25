import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import { assertClientCatalogCreditAllowed } from '../../../../accounts-receivable/clients/infrastructure/datasources/postgres-client-catalog.js';
import {
  salesRemissionsOutstanding,
} from '../../../../accounts-receivable/clients/infrastructure/datasources/customer-collections-reads.js';
import { ConflictError } from '../../../../../shared/domain/errors/conflict-error.js';
import { connectPostgres, postgresConfigured, type PostgresClient, type PostgresConnectionFactory } from '../../../../../shared/infrastructure/database/postgres-pool.js';
import { migratePostgres } from '../../../../../shared/infrastructure/datasources/postgres-schema.js';
import type { MovementDocument } from '../../../../inventories/movements/domain/entities/inventory-movement.js';
import { writeLayerStock } from '../../../../inventories/movements/infrastructure/datasources/inventory-adjustment-layers.js';
import { MysqlInventoryAdjustmentReferences } from '../../../../inventories/movements/infrastructure/datasources/mysql-inventory-adjustment-references.js';
import { normalizeOrderWarehouse } from '../../../orders/domain/entities/order-warehouse.js';
import type { OrderProps } from '../../../orders/domain/entities/order.js';
import { PostgresOrderOverlayDataSource } from '../../../orders/infrastructure/datasources/postgres-order-overlay-data-source.js';
import { assertSaleStock } from '../../../orders/infrastructure/datasources/sales-order-inventory-stock.js';
import type { InvoiceFromOrderCommand, InvoiceFromOrderResult, InvoiceFromOrderStorage } from '../../domain/datasources/invoice-from-order-data-source.js';
import { allocateSalesRemissionLayers, ensureSalesRemissionPepsSchema, type SalesRemissionLayerReferences } from './sales-remission-peps.js';

const idStart = 7100000000000;
const idEnd = idStart + 99999998;
export const isLocalSalesRemissionId = (id: number) => id >= idStart && id <= idEnd;
export const localSalesRemissionNumber = (id: number) => 'FAW' + String(id - idStart + 1).padStart(8, '0');

const migrations = [{
  id: 'sales_remission_capture',
  sql: `
    CREATE SEQUENCE tuvansa.sales_remission_ids START WITH ${idStart} MAXVALUE ${idEnd};
    CREATE SEQUENCE tuvansa.sales_remission_line_ids START WITH 7200000000000;
    CREATE TABLE tuvansa.sales_remissions (
      id bigint PRIMARY KEY,
      number varchar(15) NOT NULL UNIQUE,
      request_key uuid NOT NULL,
      fingerprint char(64) NOT NULL,
      company_id integer NOT NULL,
      user_id integer NOT NULL CHECK(user_id >= 0),
      order_id bigint NOT NULL REFERENCES tuvansa.orders(id),
      order_number varchar(15) NOT NULL,
      order_revision integer NOT NULL,
      customer_id bigint NOT NULL,
      issued_at date NOT NULL,
      warehouse varchar(6) NOT NULL,
      result jsonb NOT NULL,
      movement jsonb NOT NULL,
      line_effects jsonb NOT NULL,
      charge numeric(18,2) NOT NULL CHECK (charge >= 0),
      UNIQUE(company_id,request_key),
      UNIQUE(order_id,order_revision)
    );
    CREATE INDEX sales_remissions_customer ON tuvansa.sales_remissions(company_id,customer_id,issued_at,id);
    CREATE INDEX sales_remissions_order ON tuvansa.sales_remissions(order_id,number);
    CREATE TABLE tuvansa.sales_remission_inventory (
      remittance_id bigint NOT NULL REFERENCES tuvansa.sales_remissions(id) ON DELETE CASCADE,
      product_id bigint NOT NULL,
      warehouse varchar(6) NOT NULL,
      quantity numeric(18,3) NOT NULL CHECK (quantity < 0),
      PRIMARY KEY(remittance_id,product_id,warehouse)
    );
    CREATE INDEX sales_remission_inventory_product ON tuvansa.sales_remission_inventory(product_id,warehouse);
  `,
}];

export async function ensureSalesRemissionSchema(client: PostgresClient) {
  await migratePostgres(client, migrations);
  await ensureSalesRemissionPepsSchema(client);
}

const unavailable = () => new ApplicationError('No fue posible consultar o guardar la remisión en PostgreSQL.', 'SALES_REMISSION_POSTGRES_UNAVAILABLE', 503);

async function read<T>(fallback: T, callback: (client: PostgresClient) => Promise<T>): Promise<T> {
  if (!postgresConfigured()) return fallback;
  let client: PostgresClient | undefined;
  try {
    client = await connectPostgres();
    return await callback(client);
  } catch (error) {
    if (error instanceof ApplicationError) throw error;
    throw unavailable();
  } finally { client?.release(); }
}

export async function salesRemissionsAvailable(client: PostgresClient): Promise<boolean> {
  const { rows } = await client.query<{ available: boolean }>("SELECT to_regclass('tuvansa.sales_remissions') IS NOT NULL AS available");
  return rows[0]?.available === true;
}

export function readSalesRemissions<T>(fallback: T, callback: (client: PostgresClient) => Promise<T>) {
  return read(fallback, async (client) => await salesRemissionsAvailable(client) ? callback(client) : fallback);
}

export class PostgresSalesRemissions implements InvoiceFromOrderStorage {
  private migration?: Promise<void>;

  constructor(
    private readonly orders = new PostgresOrderOverlayDataSource(),
    private readonly connect: PostgresConnectionFactory = connectPostgres,
    private readonly layers: SalesRemissionLayerReferences = new MysqlInventoryAdjustmentReferences(),
  ) {}

  writable() { return this.orders.configured; }

  order(number: string) {
    return read<{ order: OrderProps; revision: number } | null>(null, async (client) => {
      const { rows: [table] } = await client.query<{ available: boolean }>("SELECT to_regclass('tuvansa.orders') IS NOT NULL AS available");
      if (!table?.available) return null;
      const { rows: [row] } = await client.query<{ order: OrderProps; revision: number }>(
        `SELECT document AS "order",revision FROM tuvansa.orders
         WHERE lower(number)=lower($1) AND legacy_id IS NULL AND deleted_at IS NULL`, [number],
      );
      return row ?? null;
    });
  }

  private async replay(client: PostgresClient, companyId: number, requestKey: string, fingerprint: string) {
    const { rows: [row] } = await client.query<{ fingerprint: string; result: InvoiceFromOrderResult }>(
      'SELECT fingerprint,result FROM tuvansa.sales_remissions WHERE company_id=$1 AND request_key=$2', [companyId, requestKey],
    );
    if (row && row.fingerprint !== fingerprint) {
      throw new ConflictError('La solicitud de remisión ya se usó con otros datos.', 'SALES_REMISSION_REQUEST_CONFLICT');
    }
    return row?.result ?? null;
  }

  findRequest(companyId: number, requestKey: string, fingerprint: string) {
    return readSalesRemissions<InvoiceFromOrderResult | null>(null, (client) => this.replay(client, companyId, requestKey, fingerprint));
  }

  private async migrate() {
    await this.orders.initialize();
    const client = await this.connect();
    try { await ensureSalesRemissionSchema(client); } finally { client.release(); }
  }

  async commit({ companyId, userId, requestKey, fingerprint, orderId, orderNumber, revision, post }: InvoiceFromOrderCommand) {
    if (!this.writable()) throw unavailable();
    this.migration ??= this.migrate().catch(() => {
      delete this.migration;
      throw unavailable();
    });
    await this.migration;
    const replay = async (client: PostgresClient) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('sales-remission:' || $1 || ':' || $2,0))", [String(companyId), requestKey]);
      return this.replay(client, companyId, requestKey, fingerprint);
    };
    return this.orders.postRemission(orderId, revision, replay, async (client, current) => {
      if (current.number !== orderNumber) throw new ConflictError('El folio del pedido cambió.', 'SALES_REMISSION_ORDER_CHANGED');
      await assertClientCatalogCreditAllowed(client, current.customer.id);
      const balance = await salesRemissionsOutstanding(client, companyId, current.customer.id);
      const draft = await post(current, balance);
      await assertSaleStock(client, current, draft.stock);
      const posting = await allocateSalesRemissionLayers(client, draft, this.layers);
      const { rows: [sequence] } = await client.query<{ id: string }>("SELECT nextval('tuvansa.sales_remission_ids') AS id");
      const id = Number(sequence!.id);
      const number = localSalesRemissionNumber(id);
      const { rows: lineIds } = await client.query<{ id: string }>(
        "SELECT nextval('tuvansa.sales_remission_line_ids') AS id FROM generate_series(1,$1::int)", [posting.invoice.lines.length],
      );
      const result: InvoiceFromOrderResult = {
        invoice: { ...posting.invoice, id, number, lines: posting.invoice.lines.map((line, index) => ({ ...line, id: Number(lineIds[index]!.id) })) },
        orderComplete: posting.orderComplete,
      };
      const movement: MovementDocument = {
        ...posting.movement, header: { ...posting.movement.header, document: number, id },
        lines: posting.movement.lines.map((line, index) => ({ ...line, id: Number(lineIds[index]!.id) })),
      };
      const warehouse = normalizeOrderWarehouse(current.warehouse);
      await client.query(
        `INSERT INTO tuvansa.sales_remissions
          (id,number,request_key,fingerprint,company_id,user_id,order_id,order_number,order_revision,customer_id,issued_at,warehouse,result,movement,line_effects,charge)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb,$15::jsonb,$16)`,
        [id, number, requestKey, fingerprint, companyId, userId, current.id, current.number, revision + 1, current.customer.id,
          posting.invoice.dates.issuedAt, warehouse, JSON.stringify(result), JSON.stringify(movement), JSON.stringify(posting.lineEffects), posting.receivable.amount],
      );
      await client.query(
        `INSERT INTO tuvansa.sales_remission_inventory(remittance_id,product_id,warehouse,quantity)
         SELECT $1,product,$2,-quantity FROM unnest($3::bigint[],$4::numeric[]) AS rows(product,quantity)`,
        [id, warehouse, posting.stock.map(({ productId }) => productId), posting.stock.map(({ quantity }) => quantity)],
      );
      await writeLayerStock(client, 'remission_id', id, movement.lines, false, posting.queueChanges);
      return { order: posting.order, result };
    });
  }
}
