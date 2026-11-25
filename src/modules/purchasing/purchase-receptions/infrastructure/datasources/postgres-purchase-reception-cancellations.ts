import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import { ConflictError } from '../../../../../shared/domain/errors/conflict-error.js';
import { NotFoundError } from '../../../../../shared/domain/errors/not-found-error.js';
import { connectPostgres, postgresConfigured, type PostgresClient, type PostgresConnectionFactory } from '../../../../../shared/infrastructure/database/postgres-pool.js';
import { migratePostgres } from '../../../../../shared/infrastructure/datasources/postgres-schema.js';
import type { MovementDocument } from '../../../../inventories/movements/domain/entities/inventory-movement.js';
import { lockPepsProducts, writeLayerStock } from '../../../../inventories/movements/infrastructure/datasources/inventory-adjustment-layers.js';
import { assertWarehouseStock, lockWarehouseStock } from '../../../../sales/orders/infrastructure/datasources/sales-order-inventory-stock.js';
import type { PostgresPurchaseOrderEdits } from '../../../purchase-orders/infrastructure/datasources/postgres-purchase-order-edits.js';
import type { PostingReversalResult } from '../../domain/datasources/purchase-posting-reversal-data-source.js';
import type {
  HistoricalReceiptCancellationSource, PurchaseReceptionCancellationDataSource,
  ReceiptCancellationCommand, ReceiptCancellationSource, ReceiptCancellationStock,
} from '../../domain/datasources/purchase-reception-cancellation-data-source.js';
import { historicalReceptionCancellationsOn } from './historical-purchase-reception-cancellation-reads.js';
import { getDocumentPaymentStatus } from './postgres-purchase-posting-reversals.js';
import { ensurePurchaseReceptionSchema, isLocalPurchaseReceptionId } from './postgres-purchase-reception-writes.js';
import { verifyReceiptLayerStock } from './purchase-reception-peps.js';
import { lockPurchaseReceptionPieces, receiptHasInvoicedPieces, retirePurchaseReceptionPieces } from './purchase-reception-piece-reads.js';
import { groupedSupplierBalanceReason, hasSupplierBalanceGrouping } from '../../../../../shared/infrastructure/datasources/supplier-balance-grouping-reads.js';
import { matchesReceiptSupplierChange, receiptSupplierChangesOn } from './purchase-reception-supplier-change-reads.js';
import { purchaseReceptionDocumentationsOn } from './purchase-reception-documentation-reads.js';
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
` }, { id: 'historical_purchase_reception_cancellations', sql: `
  ALTER TABLE tuvansa.purchase_reception_cancellations
    ALTER COLUMN receipt_id DROP NOT NULL,
    ADD COLUMN legacy_receipt_id bigint UNIQUE,
    ADD COLUMN historical_source jsonb,
    ADD CHECK (
      (receipt_id IS NOT NULL AND legacy_receipt_id IS NULL AND historical_source IS NULL)
      OR (receipt_id IS NULL AND legacy_receipt_id IS NOT NULL AND historical_source IS NOT NULL
        AND jsonb_typeof(historical_source)='object')
    );
  CREATE INDEX purchase_reception_historical_supplier
    ON tuvansa.purchase_reception_cancellations (((historical_source->>'supplierId')::bigint))
    WHERE legacy_receipt_id IS NOT NULL;
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
  return {
    ...row, paymentActive: active, lastReversalDate, alreadyRecorded: cancellation?.result ?? null,
    piecesInvoiced: await receiptHasInvoicedPieces(client, companyId, receiptId),
    documented: (await purchaseReceptionDocumentationsOn(client, { sourceIds: [receiptId] })).length > 0,
  };
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
    private readonly historical?: HistoricalReceiptCancellationSource,
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

  private async readHistorical(client: PostgresClient, companyId: number, receiptId: number) {
    if (companyId !== 1 || !this.historical) return null;
    const [source, [saved], documentations, grouped] = await Promise.all([
      this.historical.read(receiptId), historicalReceptionCancellationsOn(client, { receiptIds: [receiptId] }),
      purchaseReceptionDocumentationsOn(client, { sourceIds: [receiptId] }),
      hasSupplierBalanceGrouping(client, receiptId),
    ]);
    if (!source) return null;
    return {
      ...source, alreadyRecorded: saved?.result ?? null, documented: documentations.length > 0,
      ...(source.historical && grouped ? { historical: { ...source.historical, blockedReason: groupedSupplierBalanceReason } } : {}),
    };
  }

  source(companyId: number, receiptId: number) {
    return this.withConnection((client) => isLocalPurchaseReceptionId(receiptId)
      ? original(client, companyId, receiptId) : this.readHistorical(client, companyId, receiptId));
  }

  findRequest(companyId: number, requestKey: string, fingerprint: string) {
    return this.withConnection(async (client) => await purchaseReceptionCancellationsAvailable(client)
      ? requestResult(client, companyId, requestKey, fingerprint) : null);
  }

  checkStock(stock: ReceiptCancellationStock) {
    return this.withConnection(async (client) => {
      await verifyWarehouse(client, stock, false);
      await verifyReceiptLayerStock(client, stock);
    });
  }

  async commit({ actor, input, fingerprint, source, order, pending, supplierRevision, stock, validate }: ReceiptCancellationCommand) {
    this.migration ??= this.withConnection(async (client) => {
      await ensurePurchaseReceptionSchema(client);
      await migratePostgres(client, migrations);
    }).catch((error: unknown) => {
      delete this.migration;
      throw error;
    });
    await this.migration;
    const { companyId, userId } = actor;
    const replay = async (client: PostgresClient) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('cancel-purchase-reception:'||$1::text||':'||$2::text,0))", [companyId, input.requestKey.toLowerCase()]);
      return requestResult(client, companyId, input.requestKey, fingerprint);
    };
    const verify = async (client: PostgresClient) => {
      await lockPurchaseReceptionPieces(client, companyId, source.id);
      const current = source.historical
        ? await this.readHistorical(client, companyId, source.id) : await original(client, companyId, source.id, true);
      if (!current) throw new NotFoundError('Recepción de compra');
      validate(current);
      if (source.historical && this.historical) {
        if (current.historical?.version !== source.historical.version) {
          throw new ConflictError('La recepción cambió en PROSCAI. Vuelve a abrir la cancelación.', 'PURCHASE_RECEPTION_SOURCE_CHANGED');
        }
        const ids = stock.requests.map((row) => row.productId);
        await lockWarehouseStock(client, stock.warehouse, ids);
        const inventory = await this.historical.inventory(stock.warehouse, ids);
        const requests = stock.requests.map(({ productId, quantity }) => {
          const row = inventory.get(productId);
          if (!row || ![Number(row.onHand), Number(row.assigned)].every(Number.isFinite)) {
            throw new ConflictError('El registro de inventario cambió en PROSCAI.', 'PURCHASE_RECEPTION_SOURCE_CHANGED');
          }
          return { productId, quantity, legacyOnHand: Number(row.onHand), legacyAssigned: Number(row.assigned) };
        });
        await verifyWarehouse(client, { warehouse: stock.warehouse, requests }, false);
        return;
      }
      const { rows } = await client.query<{ productId: number; warehouse: string; quantity: number }>(
        `SELECT product_id::float8 AS "productId",warehouse,quantity::float8 FROM tuvansa.purchase_reception_inventory WHERE receipt_id=$1`, [source.id],
      );
      const requested = new Map(stock.requests.map(({ productId, quantity }) => [productId, quantity]));
      if (rows.length !== requested.size || rows.some(({ productId, warehouse, quantity }) => warehouse !== stock.warehouse || requested.get(productId) !== quantity)) {
        throw new ConflictError('Las cantidades del movimiento original cambiaron.', 'PURCHASE_RECEPTION_CANCELLATION_STOCK_CHANGED');
      }
      await verifyWarehouse(client, stock, true);
      if (stock.layers) {
        await lockPepsProducts(client, stock.layers.lines.map(({ productId }) => productId));
        await verifyReceiptLayerStock(client, stock);
      }
    };
    return this.orders.postReceipt(order, pending, [], undefined, supplierRevision, replay, async (client) => {
      const [change] = await receiptSupplierChangesOn(client, { receiptIds: [source.id] });
      const supplier = matchesReceiptSupplierChange(change, source.receipt) ? change.supplier : source.receipt.supplier;
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
        header: { ...source.movement.header, id, document: number, date: input.date, type: 'K',
          reference: source.receipt.number, supplierCode: supplier.code, userId },
        lines: source.movement.lines.map((line, index) => ({ ...line, id: Number(lineIds[index]!.id), type: 'K', quantity: -line.quantity, userId })),
        totals: { quantity: -source.movement.totals.quantity, cost: -source.movement.totals.cost },
      };
      await client.query(
        `INSERT INTO tuvansa.purchase_reception_cancellations
          (id,receipt_id,company_id,user_id,request_key,fingerprint,date,reason,number,policy_number,movement,accounting,result,
           legacy_receipt_id,historical_source)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13::jsonb,$14,$15::jsonb)`,
        [id, source.historical ? null : source.id, companyId, userId, input.requestKey, fingerprint, input.date, input.reason, number, policyNumber,
          JSON.stringify(movement), JSON.stringify(accounting), JSON.stringify(result), source.historical ? source.id : null,
          source.historical ? JSON.stringify({
            supplierId: supplier.id, supplierName: supplier.name, number: source.receipt.number,
            supplierReference: source.receipt.supplierReference, amount: source.payable!.amount,
            policyNumber: source.accounting!.number, version: source.historical.version,
          }) : null],
      );
      await client.query(
        `INSERT INTO tuvansa.purchase_reception_cancellation_inventory (cancellation_id,product_id,warehouse,quantity)
         SELECT $1,product,$2,-quantity FROM unnest($3::bigint[],$4::numeric[]) AS lines(product,quantity)`,
        [id, stock.warehouse, stock.requests.map(({ productId }) => productId), stock.requests.map(({ quantity }) => quantity)],
      );
      if (stock.layers) {
        // MRECEP/25. Mantiene la llave PEPS y vuelve a cero la cantidad inicial.
        await writeLayerStock(client, 'receipt_id', source.id, source.movement.lines, true);
        await client.query('UPDATE tuvansa.inventory_adjustment_layers SET initial=0 WHERE id=ANY($1::bigint[])',
          [stock.layers.lines.map(({ lotId }) => lotId)]);
      }
      await retirePurchaseReceptionPieces(client, companyId, source.id);
      return result;
    }, verify);
  }
}
