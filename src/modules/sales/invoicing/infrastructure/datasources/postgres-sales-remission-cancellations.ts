import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import { ConflictError } from '../../../../../shared/domain/errors/conflict-error.js';
import { NotFoundError } from '../../../../../shared/domain/errors/not-found-error.js';
import { connectPostgres, postgresConfigured, type PostgresClient, type PostgresConnectionFactory } from '../../../../../shared/infrastructure/database/postgres-pool.js';
import { migratePostgres } from '../../../../../shared/infrastructure/datasources/postgres-schema.js';
import { remissionCollectionStatus } from '../../../../accounts-receivable/clients/infrastructure/datasources/customer-collections-reads.js';
import type { MovementDocument } from '../../../../inventories/movements/domain/entities/inventory-movement.js';
import { PostgresOrderOverlayDataSource } from '../../../orders/infrastructure/datasources/postgres-order-overlay-data-source.js';
import { lockWarehouseStock } from '../../../orders/infrastructure/datasources/sales-order-inventory-stock.js';
import type {
  SalesRemissionCancellationCommand, SalesRemissionCancellationDataSource, SalesRemissionCancellationResult, SalesRemissionCancellationSource,
} from '../../domain/datasources/sales-remission-cancellation-data-source.js';
import { isLocalSalesRemissionId, salesRemissionsAvailable } from './postgres-sales-remissions.js';
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
      || movement.warehouse !== source.warehouse || !Number.isFinite(effect.quantity) || effect.quantity <= 0) throw inconsistent();
    const units = Math.round(effect.quantity * 1000);
    products.set(effect.productId, (products.get(effect.productId) ?? 0) + units);
  }
  await lockWarehouseStock(client, source.warehouse, [...products.keys()]);
  const { rows } = await client.query<{ product: number; warehouse: string; quantity: number }>(
    `SELECT product_id::float8 AS product,warehouse,quantity::float8 FROM tuvansa.sales_remission_inventory WHERE remittance_id=$1`, [source.id],
  );
  if (rows.length !== products.size || rows.some(({ product, warehouse, quantity }) => warehouse !== source.warehouse
    || Math.round(-quantity * 1000) !== products.get(product))) throw inconsistent();
}

export class PostgresSalesRemissionCancellations implements SalesRemissionCancellationDataSource {
  private migration?: Promise<void>;
  constructor(
    private readonly orders: Pick<PostgresOrderOverlayDataSource, 'cancelRemission'> = new PostgresOrderOverlayDataSource(),
    private readonly connect: PostgresConnectionFactory = connectPostgres,
    private readonly configured = postgresConfigured,
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

  source(companyId: number, id: number) { return this.withConnection((client) => original(client, companyId, id)); }

  findRequest(companyId: number, requestKey: string, fingerprint: string) {
    return this.withConnection(async (client) => await salesRemissionCancellationsAvailable(client)
      ? priorRequest(client, companyId, requestKey, fingerprint) : null);
  }

  async commit({ companyId, userId, id, source, input, fingerprint, validate, regenerate }: SalesRemissionCancellationCommand) {
    this.migration ??= this.withConnection((client) => migratePostgres(client, migrations)).catch((error: unknown) => {
      delete this.migration;
      throw error;
    });
    await this.migration;
    const replay = async (client: PostgresClient) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('cancel-sales-remission:'||$1::text||':'||$2::text,0))", [companyId, input.requestKey]);
      return priorRequest(client, companyId, input.requestKey, fingerprint);
    };
    return this.orders.cancelRemission(input.regenerateOrder ? source.orderId : null, replay, async (client, order) => {
      // Collection capture takes the same credit lock before locking the remisión.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('sales-credit:'||$1::text||':'||$2::text,0))", [companyId, source.customerId]);
      const current = await original(client, companyId, id, true);
      if (!current) throw new NotFoundError('Remisión FAW registrada en la web');
      validate(current);
      await validateInventory(client, current);
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
        `INSERT INTO tuvansa.sales_remission_cancellations (id,remission_id,number,company_id,user_id,request_key,fingerprint,date,reason,regenerated_order,movement,result)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb)`,
        [cancellationId, id, number, companyId, userId, input.requestKey, fingerprint, input.date, input.reason, result.regeneratedOrder,
          JSON.stringify(movement), JSON.stringify(result)],
      );
      await client.query(
        `INSERT INTO tuvansa.sales_remission_cancellation_inventory (cancellation_id,product_id,warehouse,quantity)
         SELECT $1,product_id,warehouse,-quantity FROM tuvansa.sales_remission_inventory WHERE remittance_id=$2`, [cancellationId, id],
      );
      return { order: regenerated, result };
    });
  }
}
