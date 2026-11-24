import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import { ConflictError } from '../../../../../shared/domain/errors/conflict-error.js';
import { NotFoundError } from '../../../../../shared/domain/errors/not-found-error.js';
import { connectPostgres, postgresConfigured, type PostgresClient, type PostgresConnectionFactory } from '../../../../../shared/infrastructure/database/postgres-pool.js';
import { migratePostgres } from '../../../../../shared/infrastructure/datasources/postgres-schema.js';
import type { MovementDocument } from '../../../../inventories/movements/domain/entities/inventory-movement.js';
import { assertWarehouseStock } from '../../../../sales/orders/infrastructure/datasources/sales-order-inventory-stock.js';
import type { PostgresPurchaseOrderEdits } from '../../../purchase-orders/infrastructure/datasources/postgres-purchase-order-edits.js';
import type { PostingReversalResult } from '../../domain/datasources/purchase-posting-reversal-data-source.js';
import type {
  PurchaseReceptionCancellationDataSource, ReceiptCancellationCommand, ReceiptCancellationSource, ReceiptCancellationStock,
} from '../../domain/datasources/purchase-reception-cancellation-data-source.js';
import { getDocumentPaymentStatus } from './postgres-purchase-posting-reversals.js';
import { isLocalPurchaseReceptionId } from './postgres-purchase-reception-writes.js';
import { postingReversalSeriesLength, purchaseReceptionCancellationIdStart, purchaseReceptionCancellationsAvailable } from './purchase-posting-reversal-tables.js';

const firstId = purchaseReceptionCancellationIdStart;
const migrations = [{ id: 'purchase_reception_cancellations', sql: `
  CREATE SEQUENCE tuvansa.purchase_reception_cancellation_ids START WITH ${firstId} MAXVALUE ${firstId + postingReversalSeriesLength - 1};
  CREATE TABLE tuvansa.purchase_reception_cancellations (
    id bigint PRIMARY KEY,
    receipt_id bigint NOT NULL UNIQUE REFERENCES tuvansa.purchase_receptions(id),
    company_id integer NOT NULL CHECK (company_id = 1),
    user_id integer NOT NULL CHECK (user_id >= 0),
    request_key uuid NOT NULL,
    fingerprint char(64) NOT NULL,
    date date NOT NULL,
    reason varchar(90) NOT NULL CHECK (length(trim(reason)) > 0),
    number varchar(13) NOT NULL UNIQUE,
    policy_number varchar(11) NOT NULL UNIQUE,
    movement jsonb NOT NULL CHECK (jsonb_typeof(movement) = 'object'),
    accounting jsonb NOT NULL CHECK (jsonb_typeof(accounting) = 'object'),
    created_at timestamptz NOT NULL DEFAULT now(),
    result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
    UNIQUE(company_id,request_key)
  );
  CREATE TABLE tuvansa.purchase_reception_cancellation_inventory (
    cancellation_id bigint NOT NULL REFERENCES tuvansa.purchase_reception_cancellations(id),
    product_id bigint NOT NULL,
    warehouse varchar(10) NOT NULL,
    quantity numeric(18,3) NOT NULL CHECK (quantity < 0),
    PRIMARY KEY(cancellation_id,product_id,warehouse)
  );
  CREATE INDEX purchase_reception_cancellation_inventory_product ON tuvansa.purchase_reception_cancellation_inventory(product_id,warehouse);
` }];

const unavailable = () => new ApplicationError('No fue posible consultar o cancelar la recepción en PostgreSQL.', 'PURCHASE_RECEPTION_CANCELLATION_POSTGRES_UNAVAILABLE', 503);

async function requestResult(client: PostgresClient, companyId: number, key: string, fingerprint: string) {
  const { rows: [saved] } = await client.query<{ fingerprint: string; result: PostingReversalResult }>(
    'SELECT fingerprint,result FROM tuvansa.purchase_reception_cancellations WHERE company_id=$1 AND request_key=$2', [companyId, key],
  );
  if (saved && saved.fingerprint !== fingerprint) {
    throw new ConflictError('La solicitud ya se usó con otros datos.', 'PURCHASE_RECEPTION_CANCELLATION_REQUEST_CONFLICT');
  }
  return saved?.result ?? null;
}

async function original(client: PostgresClient, companyId: number, receiptId: number, lock = false): Promise<ReceiptCancellationSource | null> {
  if (companyId !== 1 || !isLocalPurchaseReceptionId(receiptId)) return null;
  const { rows: [available] } = await client.query<{ present: boolean }>(
    "SELECT to_regclass('tuvansa.purchase_receptions') IS NOT NULL AS present",
  );
  if (!available?.present) return null;
  const { rows: [row] } = await client.query<Omit<ReceiptCancellationSource, 'alreadyRecorded' | 'paymentActive' | 'lastReversalDate'>>(
    `SELECT id::float8,order_id::float8 AS "orderId",order_number AS "orderNumber",result->'reception' AS receipt,
       order_line_effects AS "orderLineEffects",movement,accounting,payable,(result->>'orderRetired')::boolean AS "orderRetired"
     FROM tuvansa.purchase_receptions WHERE id=$1 AND company_id=$2 AND number LIKE 'RW%' ${lock ? 'FOR UPDATE' : ''}`, [receiptId, companyId],
  );
  if (!row) return null;
  const { active, lastReversalDate } = await getDocumentPaymentStatus(client, companyId, [receiptId]);
  const { rows: [cancellation] } = await purchaseReceptionCancellationsAvailable(client)
    ? await client.query<{ result: PostingReversalResult }>(
      'SELECT result FROM tuvansa.purchase_reception_cancellations WHERE receipt_id=$1 AND company_id=$2', [receiptId, companyId],
    ) : { rows: [] };
  return { ...row, paymentActive: active, lastReversalDate, alreadyRecorded: cancellation?.result ?? null };
}

function verifyWarehouse(client: PostgresClient, { warehouse, requests }: ReceiptCancellationStock, lock: boolean) {
  return assertWarehouseStock(client, warehouse, requests, () => new ConflictError(
    `La existencia libre del almacén ${warehouse} ya no cubre las cantidades de la recepción.`, 'PURCHASE_RECEPTION_CANCELLATION_STOCK_INSUFFICIENT',
  ), null, lock);
}

export class PostgresPurchaseReceptionCancellations implements PurchaseReceptionCancellationDataSource {
  private migration?: Promise<void>;
  constructor(
    private readonly orders: Pick<PostgresPurchaseOrderEdits, 'postReceipt'>,
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

  source(companyId: number, receiptId: number) { return this.withConnection((client) => original(client, companyId, receiptId)); }

  findRequest(companyId: number, requestKey: string, fingerprint: string) {
    return this.withConnection(async (client) => await purchaseReceptionCancellationsAvailable(client)
      ? requestResult(client, companyId, requestKey, fingerprint) : null);
  }

  checkStock(stock: ReceiptCancellationStock) { return this.withConnection((client) => verifyWarehouse(client, stock, false)); }

  async commit({ actor, input, fingerprint, source, order, pending, supplierRevision, stock, validate }: ReceiptCancellationCommand) {
    this.migration ??= this.withConnection((client) => migratePostgres(client, migrations)).catch((error: unknown) => {
      delete this.migration;
      throw error;
    });
    await this.migration;
    const { companyId, userId } = actor;
    const replay = async (client: PostgresClient) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('cancel-purchase-reception:'||$1::text||':'||$2::text,0))", [companyId, input.requestKey]);
      return requestResult(client, companyId, input.requestKey, fingerprint);
    };
    const verify = async (client: PostgresClient) => {
      const current = await original(client, companyId, source.id, true);
      if (!current) throw new NotFoundError('Recepción RW registrada en la web');
      validate(current);
      const { rows } = await client.query<{ productId: number; warehouse: string; quantity: number }>(
        `SELECT product_id::float8 AS "productId",warehouse,quantity::float8 FROM tuvansa.purchase_reception_inventory WHERE receipt_id=$1`, [source.id],
      );
      const requested = new Map(stock.requests.map(({ productId, quantity }) => [productId, quantity]));
      if (rows.length !== requested.size || rows.some(({ productId, warehouse, quantity }) => warehouse !== stock.warehouse || requested.get(productId) !== quantity)) {
        throw new ConflictError('Las cantidades del movimiento original cambiaron.', 'PURCHASE_RECEPTION_CANCELLATION_STOCK_CHANGED');
      }
      await verifyWarehouse(client, stock, true);
    };
    return this.orders.postReceipt(order, pending, [], undefined, supplierRevision, replay, async (client) => {
      const { rows: [allocation] } = await client.query<{ id: string }>("SELECT nextval('tuvansa.purchase_reception_cancellation_ids') AS id");
      const id = Number(allocation!.id);
      const suffix = String(id - firstId + 1).padStart(8, '0');
      const number = `KW${suffix}`;
      const policyNumber = `3KR${suffix}`;
      const result = { id, policyNumber, date: input.date, reason: input.reason };
      const sourceAccounting = source.accounting!;
      const accounting = {
        type: sourceAccounting.type, number: policyNumber,
        lines: sourceAccounting.lines.map(({ debit, credit, ...line }) => ({ ...line, debit: credit, credit: debit })),
      };
      const { rows: lineIds } = await client.query<{ id: string }>(
        "SELECT nextval('tuvansa.purchase_reception_line_ids') AS id FROM generate_series(1,$1::int)", [source.movement.lines.length],
      );
      const movement: MovementDocument = {
        header: { ...source.movement.header, id, document: number, date: input.date, type: 'K', reference: source.receipt.number, userId },
        lines: source.movement.lines.map((line, index) => ({ ...line, id: Number(lineIds[index]!.id), type: 'K', quantity: -line.quantity, userId })),
        totals: { quantity: -source.movement.totals.quantity, cost: -source.movement.totals.cost },
      };
      await client.query(
        `INSERT INTO tuvansa.purchase_reception_cancellations
          (id,receipt_id,company_id,user_id,request_key,fingerprint,date,reason,number,policy_number,movement,accounting,result)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13::jsonb)`,
        [id, source.id, companyId, userId, input.requestKey, fingerprint, input.date, input.reason, number, policyNumber,
          JSON.stringify(movement), JSON.stringify(accounting), JSON.stringify(result)],
      );
      await client.query(
        `INSERT INTO tuvansa.purchase_reception_cancellation_inventory (cancellation_id,product_id,warehouse,quantity)
         SELECT $1,product_id,warehouse,-quantity FROM tuvansa.purchase_reception_inventory WHERE receipt_id=$2`, [id, source.id],
      );
      return result;
    }, verify);
  }
}
