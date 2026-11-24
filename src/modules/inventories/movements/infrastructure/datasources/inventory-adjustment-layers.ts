import { ConflictError } from '../../../../../shared/domain/errors/conflict-error.js';
import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import { connectPostgres, postgresConfigured, type PostgresClient } from '../../../../../shared/infrastructure/database/postgres-pool.js';
import { scaledStock } from '../../../../sales/orders/infrastructure/datasources/sales-order-inventory-stock.js';
import type { MovementLine } from '../../domain/entities/inventory-movement.js';

export const inventoryAdjustmentDbUnavailable = () => new ApplicationError(
  'No fue posible acceder a los movimientos locales en PostgreSQL.', 'INVENTORY_ADJUSTMENT_POSTGRES_UNAVAILABLE', 503,
);

export async function readLocalInventoryAdjustments<T>(fallback: T, read: (client: PostgresClient) => Promise<T>): Promise<T> {
  if (!postgresConfigured()) return fallback;
  let client: PostgresClient | undefined;
  try {
    client = await connectPostgres();
    const { rows: [table] } = await client.query<{ available: boolean }>(
      "SELECT to_regclass('tuvansa.inventory_adjustments') IS NOT NULL AS available",
    );
    return table?.available ? await read(client) : fallback;
  } catch (error) {
    if (error instanceof ApplicationError) throw error;
    throw inventoryAdjustmentDbUnavailable();
  } finally { client?.release(); }
}

export const inventoryLayerMigration = { id: 'inventory_adjustment_layers', sql: `
  CREATE SEQUENCE tuvansa.inventory_adjustment_layer_ids START WITH 7971000000000 MAXVALUE 7971999999999;
  CREATE TABLE tuvansa.inventory_adjustment_layers (
    id bigint PRIMARY KEY,
    product_id bigint NOT NULL,
    warehouse varchar(10) NOT NULL,
    lot_date date,
    document varchar(15) NOT NULL,
    initial numeric(18,3) NOT NULL CHECK(initial > 0),
    cost numeric(18,4) NOT NULL,
    ad_valorem numeric(18,4) NOT NULL,
    layer_order integer NOT NULL,
    customs_entry varchar(15) NOT NULL,
    customs_office varchar(25) NOT NULL
  );
  CREATE INDEX inventory_adjustment_layers_product ON tuvansa.inventory_adjustment_layers(product_id,warehouse,id);
  CREATE TABLE tuvansa.inventory_adjustment_layer_stock (
    event_id bigserial,
    adjustment_id bigint NOT NULL REFERENCES tuvansa.inventory_adjustments(id),
    layer_id bigint NOT NULL,
    product_id bigint NOT NULL,
    warehouse varchar(10) NOT NULL,
    quantity numeric(18,3) NOT NULL CHECK(quantity <> 0),
    layer_order integer,
    reversal boolean NOT NULL,
    PRIMARY KEY(adjustment_id,layer_id,reversal)
  );
  CREATE INDEX inventory_adjustment_layer_stock_product ON tuvansa.inventory_adjustment_layer_stock(product_id,warehouse,layer_id);
` };

export interface AdjustmentLayer {
  id: number;
  productId: number;
  warehouse: string;
  date: string | null;
  initial: number;
  available: number;
  cost: number;
  adValorem: number;
  document: string;
  customsEntry: string;
  customsOffice: string;
  expiresAt: string | null;
  lot: string;
  number: string;
  location: string;
  layerOrder: number;
}

type LocalLayerRow = Omit<AdjustmentLayer, 'expiresAt' | 'lot' | 'number' | 'location'>;
type LayerLine = Pick<MovementLine, 'lotId' | 'lotWarehouse' | 'productId' | 'warehouse' | 'quantity'>;
export const inactivePepsOrder = 10000;
export const scaledLayerStock = (quantity: number) => Number(quantity.toFixed(4));

export async function lockPepsProducts(client: PostgresClient, products: number[]) {
  for (const product of [...new Set(products)].sort((a, b) => a - b)) {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('inventory-peps:' || $1,0))", [String(product)]);
  }
}

export function nextPepsOrder(layers: Pick<AdjustmentLayer, 'layerOrder'>[]) {
  const last = layers.reduce((max, { layerOrder }) => layerOrder < inactivePepsOrder ? Math.max(max, layerOrder) : max, 0);
  return Math.min(last + 1, 9999);
}

async function layerTables(client: PostgresClient) {
  const { rows: [row] } = await client.query<{ present: boolean }>(
    "SELECT to_regclass('tuvansa.inventory_adjustment_layers') IS NOT NULL AS present",
  );
  return row?.present ?? false;
}

export function groupPepsLayers(layers: AdjustmentLayer[]) {
  const byProduct = new Map<number, AdjustmentLayer[]>();
  for (const layer of layers.sort((a, b) => a.layerOrder - b.layerOrder || a.id - b.id)) {
    const group = byProduct.get(layer.productId) ?? [];
    group.push(layer);
    byProduct.set(layer.productId, group);
  }
  return byProduct;
}

type PepsLine = LayerLine & Pick<MovementLine, 'productCode' | 'customsEntry'>;

export function allocatePepsExit<T extends PepsLine>(line: T, layers: AdjustmentLayer[], queueChanges: Map<number, number>) {
  let remaining = -line.quantity;
  const allocated: Array<{ line: T; layer: AdjustmentLayer }> = [];
  for (const layer of layers) {
    if (remaining === 0) break;
    if (layer.available <= 0) continue;
    const quantity = Math.min(remaining, layer.available);
    if (scaledStock(quantity) !== quantity) throw new ApplicationError(
      `La capa ${layer.id} de ${line.productCode} requiere una conciliación de unidades antes de registrar la salida.`,
      'INVENTORY_ADJUSTMENT_UNSUPPORTED', 422,
    );
    const allocatedLine = { ...line, quantity: -quantity, lotId: layer.id, lotWarehouse: layer.warehouse,
      ...(layer.customsEntry ? { customsEntry: layer.customsEntry } : {}) };
    allocated.push({ line: allocatedLine, layer });
    layer.available = scaledLayerStock(layer.available - quantity);
    if (layer.available === 0) {
      layer.layerOrder = inactivePepsOrder;
      queueChanges.set(layer.id, inactivePepsOrder);
    }
    remaining = scaledStock(remaining - quantity);
  }
  if (remaining > 0) throw insufficientLayer(line.productCode, line.warehouse);
  return allocated;
}

export function reversePepsOrders(lines: PepsLine[], layers: AdjustmentLayer[]) {
  const queues = groupPepsLayers(layers);
  const orders = new Map<number, number>();
  for (const line of lines) {
    const queue = queues.get(line.productId) ?? [];
    const layer = queue.find(({ id }) => id === line.lotId);
    if (!layer || layer.warehouse !== (line.lotWarehouse ?? line.warehouse)) {
      throw new ConflictError(`La capa ${line.lotId} de ${line.productCode} ya no está disponible.`, 'INVENTORY_ADJUSTMENT_LAYER_MISSING');
    }
    layer.available = scaledLayerStock(layer.available - line.quantity);
    if (layer.available <= 0) {
      layer.layerOrder = inactivePepsOrder;
      orders.set(layer.id, layer.layerOrder);
    } else if (layer.layerOrder === inactivePepsOrder) {
      // MCPAR03/35 reactiva el mismo LOSEQ al final de la cola.
      layer.layerOrder = nextPepsOrder(queue);
      orders.set(layer.id, layer.layerOrder);
    }
  }
  return orders;
}

async function localLayerDeltas(client: PostgresClient, products: number[]) {
  const { rows } = await client.query<{ id: string; quantity: string }>(
    `SELECT layer_id AS id,sum(quantity) AS quantity FROM tuvansa.inventory_adjustment_layer_stock
     WHERE product_id=ANY($1::bigint[]) GROUP BY layer_id`, [products],
  );
  return new Map(rows.map(({ id, quantity }) => [Number(id), Number(quantity)]));
}

async function localAdjustmentLayers(client: PostgresClient, products: number[]) {
  const { rows } = await client.query<LocalLayerRow>(
    `SELECT l.id, l.product_id AS "productId", l.warehouse, to_char(l.lot_date,'YYYY-MM-DD') AS date,
            l.document, l.initial, l.cost, l.ad_valorem AS "adValorem", COALESCE(s.quantity,0) AS available,
            l.layer_order AS "layerOrder", l.customs_entry AS "customsEntry", l.customs_office AS "customsOffice"
     FROM tuvansa.inventory_adjustment_layers l
     LEFT JOIN LATERAL (SELECT sum(quantity) AS quantity FROM tuvansa.inventory_adjustment_layer_stock
       WHERE product_id=l.product_id AND warehouse=l.warehouse AND layer_id=l.id) s ON true
     WHERE l.product_id=ANY($1::bigint[]) ORDER BY l.id`, [products],
  );
  return rows.map((row): AdjustmentLayer => ({
    ...row, id: Number(row.id), productId: Number(row.productId), initial: Number(row.initial), cost: Number(row.cost),
    adValorem: Number(row.adValorem), available: Number(row.available),
    expiresAt: null, lot: '', number: '', location: '',
  }));
}

async function localLayerOrders(client: PostgresClient, products: number[]) {
  const { rows } = await client.query<{ id: string; order: number }>(
    `SELECT DISTINCT ON (layer_id) layer_id AS id, layer_order AS "order"
     FROM tuvansa.inventory_adjustment_layer_stock WHERE product_id=ANY($1::bigint[]) AND layer_order IS NOT NULL
     ORDER BY layer_id,event_id DESC`, [products],
  );
  return new Map(rows.map(({ id, order }) => [Number(id), order]));
}

export function adjustmentLotState(productId: number, includeLocal: boolean) {
  const fallback = { deltas: new Map<number, number>(), orders: new Map<number, number>(), local: [] as AdjustmentLayer[] };
  return readLocalInventoryAdjustments(fallback, async (client) => {
    if (!await layerTables(client)) return fallback;
    const [deltas, orders, local] = await Promise.all([
      localLayerDeltas(client, [productId]), localLayerOrders(client, [productId]),
      includeLocal ? localAdjustmentLayers(client, [productId]) : [],
    ]);
    return { deltas, orders, local };
  });
}

export async function createAdjustmentLayer(client: PostgresClient, layer: Omit<LocalLayerRow, 'id' | 'available'>) {
  const { rows: [row] } = await client.query<{ id: string }>(
    `INSERT INTO tuvansa.inventory_adjustment_layers (id,product_id,warehouse,lot_date,document,initial,cost,ad_valorem,layer_order,customs_entry,customs_office)
     VALUES (nextval('tuvansa.inventory_adjustment_layer_ids'),$1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [layer.productId, layer.warehouse, layer.date, layer.document, layer.initial, layer.cost, layer.adValorem,
      layer.layerOrder, layer.customsEntry, layer.customsOffice],
  );
  return Number(row!.id);
}

export async function currentAdjustmentLayers(
  client: PostgresClient, products: number[], opened: AdjustmentLayer[],
) {
  const [deltas, created, orders] = await Promise.all([
    localLayerDeltas(client, products), localAdjustmentLayers(client, products), localLayerOrders(client, products),
  ]);
  return [
    ...opened.map((layer) => ({ ...layer, available: scaledLayerStock(layer.available + (deltas.get(layer.id) ?? 0)) })),
    ...created,
  ].map((layer) => ({ ...layer, layerOrder: orders.get(layer.id) ?? layer.layerOrder }));
}

export async function writeLayerStock(
  client: PostgresClient, origin: 'adjustment_id' | 'receipt_id' | 'remission_id', id: number, lines: LayerLine[], reversal: boolean,
  queueChanges?: ReadonlyMap<number, number>,
) {
  const byLayer = new Map<number, LayerLine>();
  for (const line of lines) {
    if (!line.lotId) continue;
    const previous = byLayer.get(line.lotId);
    byLayer.set(line.lotId, { ...line, quantity: scaledLayerStock((previous?.quantity ?? 0) + line.quantity) });
  }
  const layers = [...byLayer.values()].filter(({ quantity }) => quantity !== 0);
  if (!layers.length) return;
  await client.query(
    `INSERT INTO tuvansa.inventory_adjustment_layer_stock (${origin},layer_id,product_id,warehouse,quantity,reversal,layer_order)
     SELECT $1,layer,product,warehouse,quantity,$2,layer_order
     FROM unnest($3::bigint[],$4::bigint[],$5::varchar[],$6::numeric[],$7::integer[])
       AS stock(layer,product,warehouse,quantity,layer_order)`,
    [id, reversal, layers.map(({ lotId }) => lotId), layers.map(({ productId }) => productId),
      layers.map(({ lotWarehouse, warehouse }) => lotWarehouse ?? warehouse),
      layers.map(({ quantity }) => reversal ? -quantity : quantity), layers.map(({ lotId }) => queueChanges?.get(lotId) ?? null)],
  );
}

export const insufficientLayer = (productCode: string, warehouse: string) => new ConflictError(
  `Existencia PEPS insuficiente para el producto ${productCode} en el almacén ${warehouse}.`,
  'INVENTORY_ADJUSTMENT_LAYER_INSUFFICIENT',
);
