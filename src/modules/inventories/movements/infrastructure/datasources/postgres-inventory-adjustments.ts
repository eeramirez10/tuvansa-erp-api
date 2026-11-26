import { createHash } from 'node:crypto';
import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import { ConflictError } from '../../../../../shared/domain/errors/conflict-error.js';
import { NotFoundError } from '../../../../../shared/domain/errors/not-found-error.js';
import { connectPostgres, postgresConfigured, postgresUnavailable, type PostgresClient } from '../../../../../shared/infrastructure/database/postgres-pool.js';
import { migratePostgres } from '../../../../../shared/infrastructure/datasources/postgres-schema.js';
import { assertWarehouseStock, lockWarehouseStock, readLegacySaleStock, scaledStock, type SaleStockRequest } from '../../../../sales/orders/infrastructure/datasources/sales-order-inventory-stock.js';
import { catalogOtherData, catalogProductsById } from '../../../products/infrastructure/datasources/product-catalog-references.js';
import type { MovementCancellationDataSource } from '../../domain/datasources/movements-data-source.js';
import type { MovementDocument, MovementLine } from '../../domain/entities/inventory-movement.js';
import type { InventoryAdjustmentInput, InventoryAdjustmentsRepository } from '../../domain/repositories/inventory-adjustments-repository.js';
import {
  allocatePepsExit, createAdjustmentLayer, currentAdjustmentLayers, groupPepsLayers, inactivePepsOrder,
  insufficientLayer, inventoryAdjustmentDbUnavailable as dbUnavailable, inventoryLayerMigration, lockPepsProducts,
  nextPepsOrder, readLocalInventoryAdjustments, reversePepsOrders,
  writeLayerStock, type AdjustmentLayer,
} from './inventory-adjustment-layers.js';
import { MysqlInventoryAdjustmentReferences, type AdjustmentProduct } from './mysql-inventory-adjustment-references.js';
import { effectivePepsCost, effectivePepsCustoms, inventoryPepsCostsOn } from './postgres-inventory-peps-cost.js';

const idStart = 7950000000000;
const idEnd = idStart + 99999999;
export const isLocalInventoryAdjustmentId = (id: number) => id >= idStart && id <= idEnd;

const migrations = [{ id: 'inventory_adjustment_capture', sql: `
  CREATE SEQUENCE tuvansa.inventory_adjustment_ids START WITH ${idStart} MAXVALUE ${idEnd};
  CREATE SEQUENCE tuvansa.inventory_adjustment_line_ids START WITH 7970000000000;
  CREATE TABLE tuvansa.inventory_adjustments (
    id bigint PRIMARY KEY,
    document_no varchar(15) NOT NULL,
    request_key uuid UNIQUE NOT NULL,
    fingerprint char(64) NOT NULL,
    movement jsonb NOT NULL,
    original_movement jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    canceled_at timestamptz
  );
  CREATE UNIQUE INDEX inventory_adjustments_document ON tuvansa.inventory_adjustments(lower(document_no));
  CREATE TABLE tuvansa.inventory_adjustment_stock (
    adjustment_id bigint NOT NULL REFERENCES tuvansa.inventory_adjustments(id),
    product_id bigint NOT NULL,
    warehouse varchar(10) NOT NULL,
    quantity numeric(18,3) NOT NULL CHECK(quantity <> 0),
    reversal boolean NOT NULL,
    PRIMARY KEY(adjustment_id,product_id,warehouse,reversal)
  );
  CREATE INDEX inventory_adjustment_stock_product ON tuvansa.inventory_adjustment_stock(product_id,warehouse);
` }, inventoryLayerMigration];

export const ensureInventoryAdjustmentSchema = (client: PostgresClient) => migratePostgres(client, migrations);

export { readLocalInventoryAdjustments };
const unsupported = (message: string) => new ApplicationError(message, 'INVENTORY_ADJUSTMENT_UNSUPPORTED', 422);
const duplicateDocument = () => new ConflictError('El folio ya existe.', 'INVENTORY_ADJUSTMENT_DOCUMENT_EXISTS');
const insufficient = (warehouse: string, product: number) => new ConflictError(
  `Existencia disponible insuficiente para el producto ${product} en el almacén ${warehouse}.`, 'INVENTORY_ADJUSTMENT_STOCK_INSUFFICIENT',
);

async function loadCatalogProducts(client: PostgresClient, ids: number[], source: Map<number, AdjustmentProduct>) {
  const products = await catalogProductsById(ids, client);
  if (!products.size) return source;
  const extra = await catalogOtherData([...products.keys()], client);
  for (const { document, deleted } of products.values()) {
    const { id, code, description, classification, prices } = document;
    const legacy = source.get(id);
    const options = extra.get(id);
    const simpleType = classification.type === 'rawMaterial' || classification.type === 'finishedProduct'
      || (legacy !== undefined && classification.type === 'assembly');
    const plainStock = legacy ? legacy.simple && options?.noInventoryLayer !== false : options?.noInventoryLayer === true;
    const specialStock = options?.controlsPieces || options?.tariff || options?.tariffPercentage;
    const missingLayerSetting = legacy === undefined && !plainStock;
    source.set(id, {
      id, code, description, unit: classification.unit.code,
      cost: (typeof options?.list5 === 'number' ? options.list5 : prices.costs.last) + prices.costs.adValorem,
      transferCost: (typeof options?.list4 === 'number' ? options.list4 : prices.costs.average) + prices.costs.adValorem,
      active: document.isActive && !deleted && (legacy?.active ?? true),
      simple: simpleType && !classification.usesColorAndSize && plainStock && !specialStock && !options?.customsEntry,
      peps: Boolean(legacy?.peps && simpleType && !classification.usesColorAndSize && options?.noInventoryLayer !== true && !specialStock),
      layerCost: typeof options?.list5 === 'number' ? options.list5 : prices.costs.last,
      adValorem: prices.costs.adValorem,
      customsEntry: typeof options?.customsEntry === 'string' ? options.customsEntry : legacy?.customsEntry ?? '',
      customsOffice: typeof options?.customsOffice === 'string' ? options.customsOffice : legacy?.customsOffice ?? '',
      importDate: typeof options?.importDate === 'string' || options?.importDate === null ? options.importDate : legacy?.importDate ?? null,
      ...(missingLayerSetting ? { incompatibility: `Activa No manejar capa en Otros para capturar movimientos del producto ${code}.` } : {}),
      legacyOnHand: Number(legacy?.legacyOnHand ?? 0), legacyAssigned: Number(legacy?.legacyAssigned ?? 0),
    });
  }
  return source;
}

const byProduct = (lines: Pick<MovementDocument['lines'][number], 'productId' | 'quantity'>[]) => {
  const deltas = new Map<number, number>();
  for (const { productId, quantity } of lines) {
    deltas.set(productId, scaledStock((deltas.get(productId) ?? 0) + quantity));
  }
  return deltas;
};

function byWarehouse(lines: MovementDocument['lines'][number][]) {
  const warehouses = new Map<string, MovementDocument['lines']>();
  for (const line of lines) {
    const group = warehouses.get(line.warehouse) ?? [];
    group.push(line);
    warehouses.set(line.warehouse, group);
  }
  return [...warehouses.entries()].sort(([a], [b]) => a < b ? -1 : Number(a > b))
    .map(([warehouse, group]) => ({ warehouse, deltas: byProduct(group) }));
}

const movementCost = (lines: Pick<MovementDocument['lines'][number], 'quantity' | 'cost'>[], sign: number) => {
  const amount = lines.reduce((sum, { quantity, cost }) => sum
    + BigInt(Math.round(Math.abs(quantity) * 1000)) * BigInt(Math.round(cost * 10000)), 0n);
  const cents = (amount + 50000n) / 100000n;
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) throw unsupported('El importe total del movimiento excede el rango admitido.');
  return sign * Number(cents) / 100;
};

function adjustmentCost(value: number, product: AdjustmentProduct) {
  const rounded = Number(Number(value).toFixed(4));
  if (!Number.isFinite(rounded) || rounded < 0 || rounded > 999999999.9999) {
    throw unsupported(`El costo del producto ${product.code} no es válido.`);
  }
  return rounded;
}

type CaptureLine = Omit<MovementLine, 'id'>;

async function loadPepsValuation(client: PostgresClient, ids: number[], products: Map<number, AdjustmentProduct>) {
  for (const [productId, snapshot] of await inventoryPepsCostsOn(client, ids)) {
    const product = products.get(productId)!;
    const valuation = effectivePepsCost({
      average: Number((Number(product.transferCost) - Number(product.adValorem)).toFixed(4)),
      last: Number(product.layerCost), adValorem: Number(product.adValorem),
    }, snapshot);
    product.cost = valuation.last + valuation.adValorem;
    product.transferCost = valuation.average + valuation.adValorem;
    product.layerCost = valuation.last;
    product.adValorem = valuation.adValorem;
    const customs = effectivePepsCustoms({
      customsEntry: product.customsEntry ?? '', customsOffice: product.customsOffice ?? '', date: product.importDate ?? null,
    }, snapshot);
    product.customsEntry = customs.customsEntry;
    product.customsOffice = customs.customsOffice;
    product.importDate = customs.date;
  }
}

function pepsEntryData(
  product: AdjustmentProduct, warehouse: string, document: string, quantity: number, layerOrder: number,
) {
  // MCPAR03/28 y /51. Con el encabezado de pedimento vacío, la capa toma los datos de FINV.
  return {
    productId: product.id, warehouse, document, initial: quantity, layerOrder, date: product.importDate ?? null,
    cost: adjustmentCost(product.layerCost!, product), adValorem: adjustmentCost(product.adValorem!, product),
    customsEntry: product.customsEntry ?? '', customsOffice: product.customsOffice ?? '',
  };
}

async function assignMovementLineIds(client: PostgresClient, lines: CaptureLine[]): Promise<MovementLine[]> {
  if (!lines.length) return [];
  const { rows } = await client.query<{ id: string }>(
    "SELECT nextval('tuvansa.inventory_adjustment_line_ids') AS id FROM generate_series(1,$1::int)", [lines.length],
  );
  return lines.map((line, index) => ({ ...line, id: Number(rows[index]!.id) }));
}

async function writeDeltas(client: PostgresClient, movement: MovementDocument, reversal: boolean) {
  const stock = byWarehouse(movement.lines).flatMap(({ warehouse, deltas }) =>
    [...deltas].map(([productId, quantity]) => ({ warehouse, productId, quantity: reversal ? -quantity : quantity })),
  );
  await client.query(
    `INSERT INTO tuvansa.inventory_adjustment_stock (adjustment_id,product_id,warehouse,quantity,reversal)
     SELECT $1,product_id,warehouse,quantity,$2 FROM unnest($3::bigint[],$4::varchar[],$5::numeric[]) stock(product_id,warehouse,quantity)`,
    [movement.header.id, reversal, stock.map(({ productId }) => productId), stock.map(({ warehouse }) => warehouse), stock.map(({ quantity }) => quantity)],
  );
}

export async function recordInvoiceTransferInventory(
  client: PostgresClient,
  header: Omit<MovementDocument['header'], 'id' | 'document'>,
  lines: CaptureLine[],
  invoiceTransfer: NonNullable<MovementDocument['invoiceTransfer']>,
  requestKey: string,
  fingerprint: string,
) {
  const { rows: [allocation] } = await client.query<{ id: string }>("SELECT nextval('tuvansa.inventory_adjustment_ids') AS id");
  const id = Number(allocation!.id);
  const number = 'TAW' + String(id - idStart + 1).padStart(8, '0');
  const movement: MovementDocument = {
    header: { ...header, id, document: number },
    lines: await assignMovementLineIds(client, lines),
    invoiceTransfer,
    totals: {
      quantity: scaledStock(lines.reduce((total, line) => total + line.quantity, 0)),
      cost: movementCost(lines, 1),
    },
  };
  await client.query(
    `INSERT INTO tuvansa.inventory_adjustments(id,document_no,request_key,fingerprint,movement,original_movement)
     VALUES($1,$2,$3,$4,$5::jsonb,$5::jsonb)`, [id, number, requestKey, fingerprint, JSON.stringify(movement)],
  );
  await writeDeltas(client, movement, false);
  return movement;
}

export class PostgresInventoryAdjustmentsDataSource implements InventoryAdjustmentsRepository, MovementCancellationDataSource {
  private migration?: Promise<void>;

  constructor(private readonly references = new MysqlInventoryAdjustmentReferences()) {}

  async capture() {
    const reference = await this.references.capture();
    const reason = reference.reason ?? (postgresConfigured() ? null : 'Las escrituras de inventario requieren PostgreSQL.');
    return { ...reference, reason, writable: reason === null };
  }

  private async migrate() {
    const client = await connectPostgres();
    try { await ensureInventoryAdjustmentSchema(client); } finally { client.release(); }
  }

  private async transaction<T>(operation: (client: PostgresClient) => Promise<T>): Promise<T> {
    if (!postgresConfigured()) throw postgresUnavailable();
    this.migration ??= this.migrate().catch((error: unknown) => {
      delete this.migration;
      if (error instanceof ApplicationError) throw error;
      throw dbUnavailable();
    });
    await this.migration;
    let client: PostgresClient | undefined;
    try {
      client = await connectPostgres();
      await client.query('BEGIN');
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client?.query('ROLLBACK').catch(() => undefined);
      if (error instanceof ApplicationError) throw error;
      throw dbUnavailable();
    } finally { client?.release(); }
  }

  private async findRequest(client: PostgresClient, key: string, fingerprint: string) {
    const { rows: [previous] } = await client.query<{ fingerprint: string; original: MovementDocument }>(
      'SELECT fingerprint,original_movement AS original FROM tuvansa.inventory_adjustments WHERE request_key=$1', [key],
    );
    if (previous && previous.fingerprint !== fingerprint) {
      throw new ConflictError('La solicitud ya se usó con otros datos.', 'INVENTORY_ADJUSTMENT_REQUEST_CONFLICT');
    }
    return previous?.original;
  }

  async create(input: InventoryAdjustmentInput): Promise<MovementDocument> {
    const { type, date, warehouse, destinationWarehouse, document, reference, lines } = input;
    const requestKey = input.requestKey.toLowerCase();
    const fingerprint = createHash('sha256').update(JSON.stringify([
      type, date, warehouse, document ?? '', reference ?? '', lines.map(({ productId, quantity, cost }) => [productId, quantity, cost ?? null]),
      ...(destinationWarehouse === undefined ? [] : [destinationWarehouse]),
    ])).digest('hex');
    return this.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('inventory-adjustment-request:' || $1,0))", [requestKey]);
      const replay = await this.findRequest(client, requestKey, fingerprint);
      if (replay) return replay;

      const capture = await this.capture();
      if (!capture.writable) throw unsupported(capture.reason ?? 'La captura no está disponible.');
      const movement = capture.types.find(({ code }) => code === type);
      if (!movement || !capture.warehouses.some(({ code }) => code === warehouse)) {
        throw unsupported('Selecciona un tipo de movimiento y un almacén habilitados.');
      }
      if (type === 'TR' ? !destinationWarehouse || warehouse === destinationWarehouse
        || !capture.warehouses.some(({ code }) => code === destinationWarehouse) : destinationWarehouse !== undefined) {
        throw unsupported('Selecciona un almacén de destino habilitado y distinto del origen.');
      }
      const productIds = [...new Set(lines.map(({ productId }) => productId))];
      for (const code of (destinationWarehouse ? [warehouse, destinationWarehouse] : [warehouse]).sort()) {
        await lockWarehouseStock(client, code, productIds);
      }
      const products = await loadCatalogProducts(client, productIds, await this.references.products(warehouse, productIds));
      const pepsProducts = new Set(productIds.filter((id) => capture.automaticPeps && products.get(id)?.peps));
      await lockPepsProducts(client, [...pepsProducts]);
      await loadPepsValuation(client, [...pepsProducts], products);
      const sourceLines = lines.map(({ productId, quantity, cost }) => {
        const product = products.get(productId);
        if (!product) throw new NotFoundError('Producto de inventario');
        if (!product.active) throw unsupported(`El producto ${product.code} está inactivo.`);
        if ((!product.simple && !pepsProducts.has(productId)) || !product.unit.trim()) throw unsupported(
          product.incompatibility ?? `El producto ${product.code} requiere un flujo especial de inventario o una unidad base.`,
        );
        if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 999999999.999 || scaledStock(quantity) !== quantity) {
          throw unsupported(`La cantidad del producto ${product.code} no es válida.`);
        }
        // MCPAR03/33 y /37. La compañía descarga por PEPS y registra el costo promedio de catálogo en FAXINV.
        const defaultCost = destinationWarehouse || (type === 'SI' && pepsProducts.has(productId)) ? product.transferCost : product.cost;
        if (type === 'SI' && pepsProducts.has(productId) && cost !== undefined) {
          throw unsupported(`Deja vacío el costo de ${product.code}. La salida toma el costo que corresponde a PEPS.`);
        }
        const unitCost = adjustmentCost(cost ?? defaultCost, product);
        return {
          productId, productCode: product.code, description: product.description, quantity: quantity * (destinationWarehouse ? -1 : movement.sign),
          unit: product.unit, cost: unitCost, warehouse, type, lotId: 0, pieces: 0, piecesText: '', userId: 0,
        };
      });
      if (movement.sign === -1 || destinationWarehouse) {
        const requests = [...byProduct(sourceLines)].map(([productId, quantity]) => {
          const product = products.get(productId)!;
          return { productId, quantity: -quantity, legacyOnHand: Number(product.legacyOnHand), legacyAssigned: Number(product.legacyAssigned) };
        });
        await assertWarehouseStock(client, warehouse, requests, (product) => insufficient(warehouse, product), null, false);
      }
      const { rows: [allocation] } = await client.query<{ id: string }>("SELECT nextval('tuvansa.inventory_adjustment_ids') AS id");
      const id = Number(allocation!.id);
      const number = document ?? `${type}W${String(id - idStart + 1).padStart(8, '0')}`;
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('inventory-adjustment-number:' || lower($1),0))", [number]);
      const { rows: [exists] } = await client.query(
        'SELECT id FROM tuvansa.inventory_adjustments WHERE lower(document_no)=lower($1)', [number],
      );
      if (exists || await this.references.documentExists(number)) throw duplicateDocument();

      const queueChanges = new Map<number, number>();
      // EINV#17/402 con [94]=0 aplica ambas partidas con PSOLOALM=1.
      const postedLines = type !== 'TR' && pepsProducts.size
        ? await this.postPepsLayers(client, sourceLines, pepsProducts, products, warehouse, number, type === 'EI', queueChanges)
        : sourceLines;
      const signedLines = destinationWarehouse ? postedLines.flatMap((line) => [line,
        { ...line, quantity: -line.quantity, warehouse: destinationWarehouse }]) : postedLines;
      const saved: MovementDocument = {
        header: {
          id, document: number, date, reference: reference ?? '', reference2: destinationWarehouse ? warehouse : '',
          warehouse: destinationWarehouse ?? warehouse, supplierCode: '', customerCode: '',
          customerName: '', type, status: 0, company: 1, userId: 0, inventoryFlag: 1, billingFlag: 0,
        },
        lines: await assignMovementLineIds(client, signedLines),
        totals: {
          quantity: scaledStock(signedLines.reduce((sum, line) => sum + line.quantity, 0)),
          cost: movementCost(postedLines, movement.sign),
        },
      };
      await client.query(
        `INSERT INTO tuvansa.inventory_adjustments (id,document_no,request_key,fingerprint,movement,original_movement)
         VALUES($1,$2,$3,$4,$5::jsonb,$5::jsonb)`, [id, number, requestKey, fingerprint, JSON.stringify(saved)],
      );
      await writeDeltas(client, saved, false);
      await writeLayerStock(client, 'adjustment_id', saved.header.id, saved.lines, false, queueChanges);
      return saved;
    });
  }

  private async postPepsLayers(
    client: PostgresClient, lines: CaptureLine[], layered: Set<number>, products: Map<number, AdjustmentProduct>,
    warehouse: string, document: string, isEntry: boolean, queueChanges: Map<number, number>,
  ) {
    const ids = [...layered];
    const layers = groupPepsLayers(await currentAdjustmentLayers(client, ids, await this.references.layers(ids)));
    const result: CaptureLine[] = [];
    const newOrders = new Map<number, number>();
    for (const line of lines) {
      if (!layered.has(line.productId)) {
        result.push(line);
        continue;
      }
      const product = products.get(line.productId)!;
      const queue = layers.get(line.productId) ?? [];
      if (!isEntry) {
        result.push(...allocatePepsExit(line, queue, queueChanges).map((allocation) => allocation.line));
        continue;
      }
      const layerOrder = newOrders.get(product.id) ?? nextPepsOrder(queue);
      newOrders.set(product.id, Math.min(layerOrder + 1, 9999));
      const lotId = await createAdjustmentLayer(client, pepsEntryData(product, warehouse, document, line.quantity, layerOrder));
      result.push({ ...line, lotId });
    }
    return result;
  }

  async canCancel(document: MovementDocument): Promise<string | null> {
    if (document.header.type === 'TA') return 'La entrada TA está vinculada a un traspaso de Facturación.';
    if (document.header.type !== 'EI' && document.header.type !== 'TR') return null;
    try {
      await readLocalInventoryAdjustments(undefined, (client) => this.checkCancellationStock(client, document, false));
      return null;
    } catch (error) {
      if (error instanceof ConflictError) return error.message;
      throw error;
    }
  }

  private async checkCancellationStock(client: PostgresClient, movement: MovementDocument, lock: boolean) {
    const grouped = byWarehouse(movement.lines);
    if (lock) {
      for (const { warehouse, deltas } of grouped) await lockWarehouseStock(client, warehouse, [...deltas.keys()]);
      const layered = movement.lines.filter(({ lotId }) => movement.header.type === 'TR' || lotId > 0);
      await lockPepsProducts(client, layered.map(({ productId }) => productId));
    }
    for (const { warehouse, deltas } of grouped) {
      const outgoing = [...deltas].filter(([, quantity]) => quantity > 0);
      if (!outgoing.length) continue;
      const stock = await readLegacySaleStock(warehouse, outgoing.map(([productId]) => productId));
      // Products created entirely in PostgreSQL have a zero MySQL opening balance.
      const requests: SaleStockRequest[] = outgoing.map(([productId, quantity]) => ({
        productId, quantity, legacyOnHand: Number(stock.get(productId)?.onHand ?? 0), legacyAssigned: Number(stock.get(productId)?.assigned ?? 0),
      }));
      await assertWarehouseStock(client, warehouse, requests, (product) => insufficient(warehouse, product), null, false);
      const affected = movement.lines.filter((line) => line.warehouse === warehouse && line.quantity > 0 && line.lotId);
      if (affected.length) {
        const productIds = [...new Set(affected.map(({ productId }) => productId))];
        const local = await currentAdjustmentLayers(client, productIds, []);
        const available = new Map(local.map((layer) => [layer.id, layer.available]));
        for (const { lotId, quantity, productCode } of affected) {
          if (quantity > (available.get(lotId) ?? 0)) throw insufficientLayer(productCode, warehouse);
        }
      }
    }
  }

  private async pepsCancellationOrder(client: PostgresClient, movement: MovementDocument) {
    const tracked = movement.lines.filter(({ lotId }) => lotId > 0);
    if (!tracked.length) return new Map<number, number>();
    const ids = [...new Set(tracked.map(({ productId }) => productId))];
    return reversePepsOrders(tracked, await currentAdjustmentLayers(client, ids, await this.references.layers(ids)));
  }

  private async transferCancellationLines(
    client: PostgresClient, original: MovementDocument, queueChanges: Map<number, number>,
  ): Promise<MovementLine[]> {
    if (original.header.type !== 'TR' || !(await this.references.capture()).automaticPeps) return original.lines;

    const { document, warehouse, reference2: origin } = original.header;
    const ids = [...new Set(original.lines.filter(({ lotId }) => !lotId).map(({ productId }) => productId))];
    if (!ids.length) return original.lines;
    const products = await loadCatalogProducts(client, ids, await this.references.products(origin, ids));
    const layered = ids.filter((id) => products.get(id)?.peps);
    if (!layered.length) return original.lines;
    await loadPepsValuation(client, layered, products);
    const queues = groupPepsLayers(await currentAdjustmentLayers(client, layered, await this.references.layers(layered)));
    const created: AdjustmentLayer[] = [];
    const lines: MovementLine[] = [];
    const splits: CaptureLine[] = [];

    // MFACT/112 invierte las partidas en su orden original. MCPAR03/28 usa el almacén del folio.
    for (const line of original.lines) {
      const product = products.get(line.productId);
      if (line.lotId || !product?.peps) {
        lines.push(line);
        continue;
      }
      const queue = queues.get(product.id) ?? [];
      if (line.quantity < 0) {
        const data = pepsEntryData(product, warehouse, document, -line.quantity, nextPepsOrder(queue));
        const id = await createAdjustmentLayer(client, data);
        const layer = { ...data, id, available: data.initial, expiresAt: null, lot: '', number: '', location: '' };
        queue.push(layer);
        queues.set(product.id, queue);
        created.push(layer);
        lines.push({ ...line, lotId: id, lotWarehouse: warehouse });
      } else {
        // La asignación usa el signo de la reversión. El diario recibe el signo original.
        const allocations = allocatePepsExit({ ...line, quantity: -line.quantity }, queue, queueChanges)
          .map(({ line: allocated }) => ({ ...allocated, quantity: -allocated.quantity }));
        const [first, ...rest] = allocations;
        lines.push({ ...first!, id: line.id });
        splits.push(...rest);
      }
    }
    // Una capa creada y agotada en la misma reversión tiene saldo neto cero en el diario.
    const exhausted = created.filter(({ available }) => available === 0).map(({ id }) => id);
    if (exhausted.length) {
      await client.query('UPDATE tuvansa.inventory_adjustment_layers SET layer_order=$1 WHERE id=ANY($2::bigint[])',
        [inactivePepsOrder, exhausted]);
    }
    return [...lines, ...await assignMovementLineIds(client, splits)];
  }

  async cancel(id: number): Promise<void> {
    await this.transaction(async (client) => {
      const { rows: [saved] } = await client.query<{ original: MovementDocument; canceled: boolean }>(
        `SELECT original_movement AS original,canceled_at IS NOT NULL AS canceled
         FROM tuvansa.inventory_adjustments WHERE id=$1 FOR UPDATE`, [id],
      );
      if (!saved) throw new NotFoundError('Movimiento de inventario');
      if (saved.canceled) return;
      const { original } = saved;
      if (original.header.type === 'TA') {
        throw unsupported('La entrada TA está vinculada a un traspaso de Facturación.');
      }
      await this.checkCancellationStock(client, original, true);
      const queueChanges = await this.pepsCancellationOrder(client, original);
      const lines = await this.transferCancellationLines(client, original, queueChanges);
      await writeDeltas(client, original, true);
      await writeLayerStock(client, 'adjustment_id', original.header.id, lines, true, queueChanges);
      const canceled: MovementDocument = {
        ...original,
        lines: lines.map((line) => ({ ...line, type: 'K', quantity: 0, cost: 0, pieces: 0, piecesText: '' })),
        totals: { quantity: 0, cost: 0 },
      };
      await client.query('UPDATE tuvansa.inventory_adjustments SET movement=$2::jsonb,canceled_at=now() WHERE id=$1', [id, JSON.stringify(canceled)]);
    });
  }
}
