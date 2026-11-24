import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import { ConflictError } from '../../../../../shared/domain/errors/conflict-error.js';
import { NotFoundError } from '../../../../../shared/domain/errors/not-found-error.js';
import { connectPostgres, postgresConfigured, type PostgresClient, type PostgresConnectionFactory } from '../../../../../shared/infrastructure/database/postgres-pool.js';
import { migratePostgres } from '../../../../../shared/infrastructure/datasources/postgres-schema.js';
import { remissionCollectionStatus } from '../../../../accounts-receivable/clients/infrastructure/datasources/customer-collections-reads.js';
import type { MovementDocument } from '../../../../inventories/movements/domain/entities/inventory-movement.js';
import type { OrderProps } from '../../../orders/domain/entities/order.js';
import { PostgresOrderOverlayDataSource } from '../../../orders/infrastructure/datasources/postgres-order-overlay-data-source.js';
import { lockWarehouseStock } from '../../../orders/infrastructure/datasources/sales-order-inventory-stock.js';
import type {
  HistoricalSalesRemissionCancellationSource, SalesRemissionCancellationCommand, SalesRemissionCancellationDataSource,
  SalesRemissionCancellationResult, SalesRemissionCancellationSource,
} from '../../domain/datasources/sales-remission-cancellation-data-source.js';
import { historicalSalesRemissionCancellationsOn } from './historical-sales-remission-cancellation-reads.js';
import { ensureSalesRemissionSchema, isLocalSalesRemissionId, salesRemissionsAvailable } from './postgres-sales-remissions.js';
import { remissionCancellationSql, salesRemissionCancellationIdEnd, salesRemissionCancellationIdStart, salesRemissionCancellationsAvailable } from './sales-remission-cancellation-reads.js';

const migrations = [{ id: 'sales_remission_cancellations', sql: `
  CREATE SEQUENCE tuvansa.sales_remission_cancellation_ids START WITH ${salesRemissionCancellationIdStart} MAXVALUE ${salesRemissionCancellationIdEnd};
  CREATE TABLE tuvansa.sales_remission_cancellations (
    id bigint PRIMARY KEY,
    remission_id bigint NOT NULL UNIQUE REFERENCES tuvansa.sales_remissions(id),
    number varchar(15) UNIQUE NOT NULL,
    company_id integer NOT NULL CHECK (company_id=1),
    user_id integer NOT NULL CHECK (user_id>=0),
    request_key uuid NOT NULL,
    fingerprint char(64) NOT NULL,
    date date NOT NULL,
    reason varchar(90) NOT NULL CHECK (length(trim(reason))>0),
    regenerated_order boolean NOT NULL,
    movement jsonb NOT NULL CHECK (jsonb_typeof(movement)='object'),
    result jsonb NOT NULL CHECK (jsonb_typeof(result)='object'),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(company_id,request_key)
  );
  CREATE TABLE tuvansa.sales_remission_cancellation_inventory (
    cancellation_id bigint NOT NULL REFERENCES tuvansa.sales_remission_cancellations(id),
    product_id bigint NOT NULL,
    warehouse varchar(6) NOT NULL,
    quantity numeric(18,3) NOT NULL CHECK (quantity>0),
    PRIMARY KEY(cancellation_id,product_id,warehouse)
  );
  CREATE INDEX sales_remission_cancellation_inventory_product ON tuvansa.sales_remission_cancellation_inventory(product_id,warehouse);
` }, { id: 'historical_sales_remission_cancellations', sql: `
  ALTER TABLE tuvansa.sales_remission_cancellations
    ALTER COLUMN remission_id DROP NOT NULL,
    ADD COLUMN legacy_invoice_id bigint UNIQUE,
    ADD COLUMN historical_source jsonb,
    ADD CHECK (
      (remission_id IS NOT NULL AND legacy_invoice_id IS NULL AND historical_source IS NULL)
      OR (remission_id IS NULL AND legacy_invoice_id IS NOT NULL AND historical_source IS NOT NULL
        AND jsonb_typeof(historical_source)='object')
    );
  CREATE INDEX sales_remission_historical_customer
    ON tuvansa.sales_remission_cancellations (((historical_source->>'customerId')::bigint))
    WHERE legacy_invoice_id IS NOT NULL;
` }];

const unavailable = () => new ApplicationError('No fue posible consultar o cancelar la remisión en PostgreSQL.', 'SALES_REMISSION_CANCELLATION_POSTGRES_UNAVAILABLE', 503);

async function priorRequest(client: PostgresClient, companyId: number, requestKey: string, fingerprint: string) {
  const { rows: [row] } = await client.query<{ fingerprint: string; result: SalesRemissionCancellationResult }>(
    'SELECT fingerprint,result FROM tuvansa.sales_remission_cancellations WHERE company_id=$1 AND request_key=$2', [companyId, requestKey],
  );
  if (row && row.fingerprint !== fingerprint) throw new ConflictError('La solicitud ya se usó con otros datos.', 'SALES_REMISSION_CANCELLATION_REQUEST_CONFLICT');
  return row?.result ?? null;
}

async function original(client: PostgresClient, companyId: number, id: number, lock = false): Promise<SalesRemissionCancellationSource | null> {
  if (companyId !== 1 || !isLocalSalesRemissionId(id) || !await salesRemissionsAvailable(client)) return null;
  const cancellation = remissionCancellationSql(await salesRemissionCancellationsAvailable(client));
  const { rows: [row] } = await client.query<Omit<SalesRemissionCancellationSource, 'hasCollection' | 'lastCollectionReversalAt'>>(
    `SELECT remission.id::float8,remission.number,remission.issued_at::text AS "issuedAt",remission.warehouse,
       remission.customer_id::float8 AS "customerId",remission.order_id::float8 AS "orderId",remission.order_number AS "orderNumber",
       remission.charge::float8,remission.result->'invoice' AS invoice,remission.movement,remission.line_effects AS "lineEffects",
       ${cancellation.result} AS "alreadyRecorded",o.document AS "order"
       FROM tuvansa.sales_remissions remission ${cancellation.join}
       LEFT JOIN tuvansa.orders o ON o.id=remission.order_id AND o.legacy_id IS NULL AND o.deleted_at IS NULL
       WHERE remission.id=$1 AND remission.company_id=$2 AND remission.number LIKE 'FAW%' ${lock ? 'FOR UPDATE OF remission' : ''}`, [id, companyId],
  );
  return row ? { ...row, ...await remissionCollectionStatus(client, { id, customerId: row.customerId, companyId }) } : null;
}

async function validateInventory(client: PostgresClient, source: SalesRemissionCancellationSource) {
  const inconsistent = () => new ConflictError('Las partidas del movimiento de la remisión ya no coinciden.', 'SALES_REMISSION_CANCELLATION_STOCK_CHANGED');
  const products = new Map<number, number>();
  for (const [index, effect] of source.lineEffects.entries()) {
    const movement = source.movement.lines[index];
    const invoice = source.invoice.lines[index];
    if (!movement || !invoice || movement.productId !== effect.productId || invoice.productId !== effect.productId
      || movement.quantity !== -effect.quantity || invoice.fulfilledQuantity !== effect.quantity
      || movement.warehouse !== source.warehouse || !Number.isFinite(effect.quantity) || effect.quantity <= 0
      || Math.round(effect.quantity * 1000) / 1000 !== effect.quantity) throw inconsistent();
    const units = Math.round(effect.quantity * 1000);
    products.set(effect.productId, (products.get(effect.productId) ?? 0) + units);
  }
  await lockWarehouseStock(client, source.warehouse, [...products.keys()]);
  if (source.historical) return products;
  const { rows } = await client.query<{ product: number; warehouse: string; quantity: number }>(
    `SELECT product_id::float8 AS product,warehouse,quantity::float8 FROM tuvansa.sales_remission_inventory WHERE remittance_id=$1`, [source.id],
  );
  if (rows.length !== products.size || rows.some(({ product, warehouse, quantity }) => warehouse !== source.warehouse
    || Math.round(-quantity * 1000) !== products.get(product))) throw inconsistent();
  return products;
}

export class PostgresSalesRemissionCancellations implements SalesRemissionCancellationDataSource {
  private migration?: Promise<void>;
  constructor(
    private readonly orders: Pick<PostgresOrderOverlayDataSource, 'cancelRemission'> = new PostgresOrderOverlayDataSource(),
    private readonly connect: PostgresConnectionFactory = connectPostgres,
    private readonly configured = postgresConfigured,
    private readonly historical?: HistoricalSalesRemissionCancellationSource,
  ) {}

  private async withConnection<T>(work: (client: PostgresClient) => Promise<T>) {
    if (!this.configured()) throw unavailable();
    let client: PostgresClient | undefined;
    try {
      client = await this.connect();
      return await work(client);
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      throw unavailable();
    } finally { client?.release(); }
  }

  private async readHistorical(client: PostgresClient, companyId: number, id: number): Promise<SalesRemissionCancellationSource | null> {
    if (companyId !== 1 || !this.historical) return null;
    const [source, [saved]] = await Promise.all([
      this.historical.read(id), historicalSalesRemissionCancellationsOn(client, { invoiceIds: [id] }),
    ]);
    if (!source?.historical) return null;
    const baseOrder = source.order;
    let order = baseOrder;
    let orderReason = source.historical.orderReason ?? null;
    if (baseOrder && !orderReason) {
      const { rows: [table] } = await client.query<{ available: boolean }>(
        "SELECT to_regclass('tuvansa.orders') IS NOT NULL AS available",
      );
      const { rows: [overlay] } = table?.available ? await client.query<{ document: OrderProps; valid: boolean }>(
        `SELECT document,deleted_at IS NULL AND base_document=$2::jsonb AS valid
         FROM tuvansa.orders WHERE id=$1`, [baseOrder.id, JSON.stringify(baseOrder)],
      ) : { rows: [] };
      if (overlay) {
        order = overlay.valid ? overlay.document : null;
        if (!order) orderReason = 'El pedido original cambió o fue dado de baja.';
      }
    }
    return {
      ...source, order, alreadyRecorded: saved?.result ?? null,
      historical: { ...source.historical, baseOrder, orderReason },
    };
  }

  source(companyId: number, id: number) {
    return this.withConnection((client) => isLocalSalesRemissionId(id)
      ? original(client, companyId, id) : this.readHistorical(client, companyId, id));
  }

  findRequest(companyId: number, requestKey: string, fingerprint: string) {
    return this.withConnection(async (client) => await salesRemissionCancellationsAvailable(client)
      ? priorRequest(client, companyId, requestKey, fingerprint) : null);
  }

  async commit({ companyId, userId, id, source, input, fingerprint, validate, regenerate }: SalesRemissionCancellationCommand) {
    this.migration ??= this.withConnection(async (client) => {
      await migratePostgres(client);
      await ensureSalesRemissionSchema(client);
      await migratePostgres(client, migrations);
    }).catch((error: unknown) => {
      delete this.migration;
      throw error;
    });
    await this.migration;
    const replay = async (client: PostgresClient) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('cancel-sales-remission:'||$1::text||':'||$2::text,0))",
        [companyId, input.requestKey.toLowerCase()]);
      return priorRequest(client, companyId, input.requestKey, fingerprint);
    };
    return this.orders.cancelRemission(input.regenerateOrder ? source.orderId : null, replay, async (client, order) => {
      // Collection capture takes the same credit lock before locking the remisión.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('sales-credit:'||$1::text||':'||$2::text,0))", [companyId, source.customerId]);
      const current = source.historical ? await this.readHistorical(client, companyId, id) : await original(client, companyId, id, true);
      if (!current) throw new NotFoundError('Remisión');
      validate(current);
      if (source.historical && source.historical.version !== current.historical?.version) {
        throw new ConflictError('La remisión cambió en PROSCAI. Vuelve a abrir la cancelación.', 'SALES_REMISSION_SOURCE_CHANGED');
      }
      if (input.regenerateOrder && (!order || current.historical?.orderReason)) {
        throw new ConflictError('El pedido original cambió o fue dado de baja.', 'SALES_REMISSION_ORDER_CHANGED');
      }
      const products = await validateInventory(client, current);
      const regenerated = order ? regenerate(current, order) : null;

      const { rows: [allocation] } = await client.query<{ id: string }>("SELECT nextval('tuvansa.sales_remission_cancellation_ids') AS id");
      const cancellationId = Number(allocation!.id);
      const number = `KWV${String(cancellationId - salesRemissionCancellationIdStart + 1).padStart(8, '0')}`;
      const result = { id: cancellationId, date: input.date, reason: input.reason, regeneratedOrder: Boolean(regenerated) };
      const { rows: lineIds } = await client.query<{ id: string }>(
        "SELECT nextval('tuvansa.sales_remission_line_ids') AS id FROM generate_series(1,$1::int)", [current.movement.lines.length],
      );
      const movement: MovementDocument = {
        header: { ...current.movement.header, id: cancellationId, document: number, date: input.date, type: 'K', reference: current.number, userId },
        lines: current.movement.lines.map((line, index) => ({ ...line, id: Number(lineIds[index]!.id), type: 'K', quantity: -line.quantity, userId })),
        totals: { quantity: -current.movement.totals.quantity, cost: -current.movement.totals.cost },
      };
      await client.query(
        `INSERT INTO tuvansa.sales_remission_cancellations
           (id,remission_id,number,company_id,user_id,request_key,fingerprint,date,reason,regenerated_order,movement,result,legacy_invoice_id,historical_source)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13,$14::jsonb)`,
        [cancellationId, current.historical ? null : id, number, companyId, userId, input.requestKey, fingerprint, input.date, input.reason,
          result.regeneratedOrder, JSON.stringify(movement), JSON.stringify(result), current.historical ? id : null, current.historical ? JSON.stringify({
            customerId: current.customerId, number: current.number, orderNumber: current.orderNumber, amount: current.charge,
            issuedAt: current.issuedAt, dueAt: current.invoice.dates.dueAt, version: current.historical.version,
          }) : null],
      );
      await client.query(
        `INSERT INTO tuvansa.sales_remission_cancellation_inventory (cancellation_id,product_id,warehouse,quantity)
         SELECT $1,product,$2,quantity FROM unnest($3::bigint[],$4::numeric[]) AS lines(product,quantity)`,
        [cancellationId, current.warehouse, [...products.keys()], [...products.values()].map((value) => value / 1000)],
      );
      return { order: regenerated, result };
    }, input.regenerateOrder ? source.historical?.baseOrder ?? undefined : undefined);
  }
}
