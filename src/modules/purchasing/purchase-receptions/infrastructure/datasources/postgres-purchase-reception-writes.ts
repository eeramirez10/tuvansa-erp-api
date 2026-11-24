import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import { ConflictError } from '../../../../../shared/domain/errors/conflict-error.js';
import { connectPostgres, postgresConfigured, type PostgresClient, type PostgresConnectionFactory } from '../../../../../shared/infrastructure/database/postgres-pool.js';
import { migratePostgres } from '../../../../../shared/infrastructure/datasources/postgres-schema.js';
import { assertActiveSupplierCatalog } from '../../../../accounts-payable/suppliers/infrastructure/datasources/postgres-supplier-catalog-data-source.js';
import type { MovementDocument } from '../../../../inventories/movements/domain/entities/inventory-movement.js';
import { createAdjustmentLayer, currentAdjustmentLayers, inactivePepsOrder, lockPepsProducts, nextPepsOrder, writeLayerStock } from '../../../../inventories/movements/infrastructure/datasources/inventory-adjustment-layers.js';
import { MysqlInventoryAdjustmentReferences } from '../../../../inventories/movements/infrastructure/datasources/mysql-inventory-adjustment-references.js';
import { effectivePepsCost, effectivePepsCustoms, inventoryPepsCostsOn, type InventoryPepsCostSnapshot } from '../../../../inventories/movements/infrastructure/datasources/postgres-inventory-peps-cost.js';
import { localPhysicalStock, lockWarehouseStock } from '../../../../sales/orders/infrastructure/datasources/sales-order-inventory-stock.js';
import type { PostgresPurchaseOrderEdits } from '../../../purchase-orders/infrastructure/datasources/postgres-purchase-order-edits.js';
import type {
  PurchaseReceptionSaveResult, PurchaseReceptionWriteCommand, PurchaseReceptionWriteDataSource,
} from '../../domain/datasources/purchase-reception-write-data-source.js';
import { ensurePurchaseReceptionPepsSchema, receivedPepsCost, saveReceiptPepsCosts } from './purchase-reception-peps.js';

const receiptIdStart = 6700000000000;
export const isLocalPurchaseReceptionId = (id: number) => id >= receiptIdStart && id < receiptIdStart + 100000000;
const migrations = [{
  id: 'purchase_reception_capture',
  sql: `
    CREATE SEQUENCE tuvansa.purchase_reception_ids START WITH ${receiptIdStart} MAXVALUE ${receiptIdStart + 99999998};
    CREATE SEQUENCE tuvansa.purchase_reception_line_ids START WITH 6800000000000;
    CREATE TABLE tuvansa.purchase_receptions (
      id bigint PRIMARY KEY,
      number varchar(15) UNIQUE NOT NULL,
      company_id integer NOT NULL,
      user_id integer NOT NULL CHECK(user_id >= 0),
      request_key uuid NOT NULL,
      fingerprint char(64) NOT NULL,
      order_id bigint NOT NULL,
      order_number varchar(15) NOT NULL,
      order_revision integer NOT NULL,
      result jsonb NOT NULL,
      movement jsonb NOT NULL,
      order_line_effects jsonb NOT NULL,
      payable jsonb,
      accounting jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(company_id,request_key),
      UNIQUE(order_id,order_number,order_revision)
    );
    CREATE INDEX purchase_receptions_order ON tuvansa.purchase_receptions(order_id,order_number,number);
    CREATE INDEX purchase_receptions_supplier ON tuvansa.purchase_receptions(((result #>> '{reception,supplier,id}')::bigint));
    CREATE TABLE tuvansa.purchase_reception_inventory (
      receipt_id bigint NOT NULL REFERENCES tuvansa.purchase_receptions(id) ON DELETE CASCADE,
      product_id bigint NOT NULL,
      warehouse varchar(10) NOT NULL,
      quantity numeric(18,3) NOT NULL,
      PRIMARY KEY(receipt_id,product_id,warehouse)
    );
    CREATE INDEX purchase_reception_inventory_product ON tuvansa.purchase_reception_inventory(product_id,warehouse);
  `,
}];

interface Saved {
  fingerprint: string;
  result: PurchaseReceptionSaveResult;
}

export const ensurePurchaseReceptionSchema = (client: PostgresClient) => migratePostgres(client, migrations);

export type LocalReceptionRecord = {
  result: PurchaseReceptionSaveResult;
  movement: MovementDocument;
  payable: { amount: number; currencyId: number; exchangeRate: number; dueAt: string } | null;
  accounting: { number: string } | null;
};

export async function readLocalPurchaseReceptions<T>(fallback: T, read: (client: PostgresClient) => Promise<T>): Promise<T> {
  if (!postgresConfigured()) return fallback;
  let client: PostgresClient | undefined;
  try {
    client = await connectPostgres();
    const { rows: [table] } = await client.query<{ available: boolean }>(
      "SELECT to_regclass('tuvansa.purchase_receptions') IS NOT NULL AS available",
    );
    return table?.available ? await read(client) : fallback;
  } catch (error) {
    if (error instanceof ApplicationError) throw error;
    throw new ApplicationError('No fue posible consultar recepciones en PostgreSQL.', 'PURCHASE_RECEPTION_POSTGRES_UNAVAILABLE', 503);
  } finally {
    client?.release();
  }
}

export class PostgresPurchaseReceptionWrites implements PurchaseReceptionWriteDataSource {
  private migration?: Promise<void>;
  private layerMigration?: Promise<void>;

  constructor(
    private readonly orders: PostgresPurchaseOrderEdits,
    private readonly connect: PostgresConnectionFactory = connectPostgres,
    private readonly layerReferences: Pick<MysqlInventoryAdjustmentReferences, 'layers'> = new MysqlInventoryAdjustmentReferences(),
  ) {}

  writable() { return this.orders.writable(); }

  private async byRequest(client: PostgresClient, companyId: number, key: string, fingerprint: string) {
    const { rows: [row] } = await client.query<Saved>(
      'SELECT fingerprint,result FROM tuvansa.purchase_receptions WHERE company_id=$1 AND request_key=$2', [companyId, key],
    );
    if (!row) return null;
    if (row.fingerprint !== fingerprint) throw new ConflictError('La solicitud ya se usó con otros datos.', 'PURCHASE_RECEPTION_REQUEST_CONFLICT');
    return row.result;
  }

  findRequest(companyId: number, key: string, fingerprint: string) {
    return readLocalPurchaseReceptions(null as PurchaseReceptionSaveResult | null, (client) => this.byRequest(client, companyId, key, fingerprint));
  }

  private async migrate(migration: (client: PostgresClient) => Promise<void>) {
    const client = await this.connect();
    try { await migration(client); } finally { client.release(); }
  }

  private async createLayers(client: PostgresClient, posting: PurchaseReceptionWriteCommand['posting'], document: string) {
    const { pedimento } = posting.document;
    const lines = posting.lines.flatMap(({ orderLineId, movement, pepsLayer }) => pepsLayer ? [{ orderLineId, movement, pepsLayer }] : []);
    const lotIds = new Map<number, number>();
    const costs = new Map<number, InventoryPepsCostSnapshot>();
    if (!lines.length) return { lotIds, costs };
    const products = [...new Set(lines.map(({ movement }) => movement.productId))];
    await lockWarehouseStock(client, posting.document.warehouse, products);
    await lockPepsProducts(client, products);
    const [layers, existingCosts, localOnHand] = await Promise.all([
      currentAdjustmentLayers(client, products, await this.layerReferences.layers(products)),
      inventoryPepsCostsOn(client, products),
      localPhysicalStock(client, products),
    ]);
    const orders = new Map<number, number>();
    for (const { productId, layerOrder } of layers) {
      if (layerOrder < inactivePepsOrder) orders.set(productId, Math.max(orders.get(productId) ?? 0, layerOrder));
    }
    for (const { orderLineId, movement, pepsLayer } of lines) {
      const { productId, warehouse, quantity } = movement;
      const layerOrder = nextPepsOrder([{ layerOrder: orders.get(productId) ?? 0 }]);
      const { costBasis: { openingStock, ...basis }, tariff, ...customsBasis } = pepsLayer;
      const local = localOnHand.get(productId) ?? 0;
      const opening = existingCosts.get(productId);
      const previous = costs.get(productId)?.effective ?? effectivePepsCost(basis, opening);
      const currentCustoms = effectivePepsCustoms(customsBasis, opening);
      const stamped = pedimento ? { customsEntry: pedimento.number, customsOffice: pedimento.customsOffice, date: pedimento.date }
        : currentCustoms;
      const effective = await receivedPepsCost(client, previous, openingStock + local, quantity, tariff?.goodsCost ?? movement.cost, tariff?.amount);
      if (pedimento || opening?.effective.customs) {
        // MRECEP/32 actualiza cada campo de FINV sólo cuando trae un valor.
        const customs = { customsEntry: stamped.customsEntry,
          customsOffice: stamped.customsOffice || currentCustoms.customsOffice, date: stamped.date ?? currentCustoms.date };
        costs.set(productId, { basis: { ...basis, customs: customsBasis }, effective: { ...effective, customs } });
      } else {
        costs.set(productId, { basis, effective });
      }
      localOnHand.set(productId, local + quantity);
      const lotId = await createAdjustmentLayer(client, {
        ...stamped, productId, warehouse, initial: quantity, document, layerOrder,
        // MCPAR03/28. La capa de pedimento toma su propio arancel. FINV conserva el ponderado global.
        cost: effective.last, adValorem: tariff?.amount ?? effective.adValorem,
      });
      orders.set(productId, layerOrder);
      lotIds.set(orderLineId, lotId);
    }
    return { lotIds, costs };
  }

  async commit({ actor, context, effect, posting, input, fingerprint }: PurchaseReceptionWriteCommand): Promise<PurchaseReceptionSaveResult> {
    this.migration ??= this.migrate(ensurePurchaseReceptionSchema).catch(() => {
      delete this.migration;
      throw new ApplicationError('No fue posible preparar recepciones en PostgreSQL.', 'PURCHASE_RECEPTION_POSTGRES_UNAVAILABLE', 503);
    });
    await this.migration;
    if (posting.lines.some(({ pepsLayer }) => pepsLayer !== undefined)) {
      this.layerMigration ??= this.migrate(ensurePurchaseReceptionPepsSchema).catch(() => {
        delete this.layerMigration;
        throw new ApplicationError('No fue posible preparar las capas de recepción en PostgreSQL.', 'PURCHASE_RECEPTION_POSTGRES_UNAVAILABLE', 503);
      });
      await this.layerMigration;
    }
    const { id: orderId, number: orderNumber, lines, totals, status, received, classifications } = effect.order;
    const snapshot = {
      id: orderId, number: orderNumber, revision: context.revision, legacyVersion: context.sourceVersion ?? context.legacyVersion,
      lines, totals, receiving: { status, received }, amountInWords: context.amountInWords ?? null,
    };
    const replay = async (client: PostgresClient) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('purchase-reception:' || $1 || ':' || $2, 0))", [String(actor.companyId), input.requestKey]);
      return this.byRequest(client, actor.companyId, input.requestKey, fingerprint);
    };
    return this.orders.postReceipt(snapshot, effect.stock, classifications, effect.assignmentMarker, context.supplierRevision ?? 0, replay, async (client) => {
      await assertActiveSupplierCatalog(client, posting.document.supplier.id);
      const { rows: [allocation] } = await client.query<{ id: string }>("SELECT nextval('tuvansa.purchase_reception_ids') AS id");
      const id = Number(allocation!.id);
      const sequence = String(id - receiptIdStart + 1).padStart(8, '0');
      const number = `RW${sequence}`;
      const { rows: ids } = await client.query<{ id: string }>(
        "SELECT nextval('tuvansa.purchase_reception_line_ids') AS id FROM generate_series(1,$1::int)", [posting.lines.length],
      );
      const { lotIds, costs } = await this.createLayers(client, posting, number);
      const result = {
        reception: { ...posting.document, id, number, lines: posting.lines.map(({ reception, orderLineId }, index) => ({
          ...reception, id: Number(ids[index]!.id), lotId: lotIds.get(orderLineId) ?? reception.lotId,
        })) },
        orderComplete: effect.complete,
        orderRetired: effect.retireCompletedOrder,
      };
      const movementLines = posting.lines.map(({ movement, orderLineId }, index) => ({
        ...movement, id: Number(ids[index]!.id), userId: actor.userId, lotId: lotIds.get(orderLineId) ?? movement.lotId,
      }));
      const movement: MovementDocument = {
        header: { ...posting.movement, id, document: number, userId: actor.userId },
        lines: movementLines,
        totals: { quantity: posting.document.totals.units, cost: Number(movementLines.reduce((sum, line) => sum + line.quantity * line.cost, 0).toFixed(2)) },
      };
      const accounting = posting.accounting && { ...posting.accounting, number: `${posting.accounting.type}W${sequence}` };
      await client.query(
        `INSERT INTO tuvansa.purchase_receptions
         (id,number,company_id,user_id,request_key,fingerprint,order_id,order_number,order_revision,result,movement,order_line_effects,payable,accounting)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb,$13::jsonb,$14::jsonb)`,
        [id, number, actor.companyId, actor.userId, input.requestKey, fingerprint, orderId, orderNumber, context.revision + 1,
          JSON.stringify(result), JSON.stringify(movement), JSON.stringify(effect.lines),
          posting.payable ? JSON.stringify(posting.payable) : null, accounting ? JSON.stringify(accounting) : null],
      );
      await client.query(
        `INSERT INTO tuvansa.purchase_reception_inventory (receipt_id,product_id,warehouse,quantity)
         SELECT $1, product, warehouse, sum(quantity)
         FROM unnest($2::bigint[],$3::varchar[],$4::numeric[]) AS rows(product,warehouse,quantity)
         GROUP BY product,warehouse`,
        [id, movementLines.map((line) => line.productId), movementLines.map((line) => line.warehouse), movementLines.map((line) => line.quantity)],
      );
      await writeLayerStock(client, 'receipt_id', id, movementLines, false);
      await saveReceiptPepsCosts(client, id, costs);
      return result;
    });
  }
}
