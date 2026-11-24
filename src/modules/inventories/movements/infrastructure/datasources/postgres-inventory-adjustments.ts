import { createHash } from 'node:crypto';
import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import { ConflictError } from '../../../../../shared/domain/errors/conflict-error.js';
import { NotFoundError } from '../../../../../shared/domain/errors/not-found-error.js';
import { connectPostgres, postgresConfigured, postgresUnavailable, type PostgresClient } from '../../../../../shared/infrastructure/database/postgres-pool.js';
import { migratePostgres } from '../../../../../shared/infrastructure/datasources/postgres-schema.js';
import { assertWarehouseStock, lockWarehouseStock, readLegacySaleStock, scaledStock, type SaleStockRequest } from '../../../../sales/orders/infrastructure/datasources/sales-order-inventory-stock.js';
import { catalogOtherData, catalogProductsById } from '../../../products/infrastructure/datasources/product-catalog-references.js';
import type { MovementCancellationDataSource } from '../../domain/datasources/movements-data-source.js';
import type { MovementDocument } from '../../domain/entities/inventory-movement.js';
import type { InventoryAdjustmentInput, InventoryAdjustmentsRepository } from '../../domain/repositories/inventory-adjustments-repository.js';
import { MysqlInventoryAdjustmentReferences, type AdjustmentProduct } from './mysql-inventory-adjustment-references.js';

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
` }];

const dbUnavailable = () => new ApplicationError(
  'No fue posible acceder a los movimientos locales en PostgreSQL.', 'INVENTORY_ADJUSTMENT_POSTGRES_UNAVAILABLE', 503,
);
const unsupported = (message: string) => new ApplicationError(message, 'INVENTORY_ADJUSTMENT_UNSUPPORTED', 422);
const duplicateDocument = () => new ConflictError('El folio ya existe.', 'INVENTORY_ADJUSTMENT_DOCUMENT_EXISTS');
const insufficient = (warehouse: string, product: number) => new ConflictError(
  `Existencia disponible insuficiente para el producto ${product} en el almacén ${warehouse}.`, 'INVENTORY_ADJUSTMENT_STOCK_INSUFFICIENT',
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
    throw dbUnavailable();
  } finally { client?.release(); }
}

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
    const specialStock = options?.controlsPieces || options?.tariff || options?.tariffPercentage || options?.customsEntry;
    const missingLayerSetting = legacy === undefined && !plainStock;
    source.set(id, {
      id, code, description, unit: classification.unit.code,
      cost: (typeof options?.list5 === 'number' ? options.list5 : prices.costs.last) + prices.costs.adValorem,
      transferCost: (typeof options?.list4 === 'number' ? options.list4 : prices.costs.average) + prices.costs.adValorem,
      active: document.isActive && !deleted && (legacy?.active ?? true),
      simple: simpleType && !classification.usesColorAndSize && plainStock && !specialStock,
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
    try { await migratePostgres(client, migrations); } finally { client.release(); }
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
      const sourceLines = lines.map(({ productId, quantity, cost }) => {
        const product = products.get(productId);
        if (!product) throw new NotFoundError('Producto de inventario');
        if (!product.active) throw unsupported(`El producto ${product.code} está inactivo.`);
        if (!product.simple || !product.unit.trim()) throw unsupported(
          product.incompatibility ?? `El producto ${product.code} requiere un flujo especial de inventario o una unidad base.`,
        );
        if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 999999999.999 || scaledStock(quantity) !== quantity) {
          throw unsupported(`La cantidad del producto ${product.code} no es válida.`);
        }
        const defaultCost = destinationWarehouse ? product.transferCost : product.cost;
        const unitCost = Number((cost ?? Number(defaultCost)).toFixed(4));
        if (!Number.isFinite(unitCost) || unitCost < 0 || unitCost > 999999999.9999) {
          throw unsupported(`El costo del producto ${product.code} no es válido.`);
        }
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
      const signedLines = destinationWarehouse ? sourceLines.flatMap((line) => [line,
        { ...line, quantity: -line.quantity, warehouse: destinationWarehouse }]) : sourceLines;

      const { rows: [allocation] } = await client.query<{ id: string }>("SELECT nextval('tuvansa.inventory_adjustment_ids') AS id");
      const id = Number(allocation!.id);
      const number = document ?? `${type}W${String(id - idStart + 1).padStart(8, '0')}`;
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('inventory-adjustment-number:' || lower($1),0))", [number]);
      const { rows: [exists] } = await client.query(
        'SELECT id FROM tuvansa.inventory_adjustments WHERE lower(document_no)=lower($1)', [number],
      );
      if (exists || await this.references.documentExists(number)) throw duplicateDocument();

      const { rows: ids } = await client.query<{ id: string }>(
        "SELECT nextval('tuvansa.inventory_adjustment_line_ids') AS id FROM generate_series(1,$1::int)", [signedLines.length],
      );
      const saved: MovementDocument = {
        header: {
          id, document: number, date, reference: reference ?? '', reference2: destinationWarehouse ? warehouse : '',
          warehouse: destinationWarehouse ?? warehouse, supplierCode: '', customerCode: '',
          customerName: '', type, status: 0, company: 1, userId: 0, inventoryFlag: 1, billingFlag: 0,
        },
        lines: signedLines.map((line, index) => ({ ...line, id: Number(ids[index]!.id) })),
        totals: {
          quantity: scaledStock(signedLines.reduce((sum, line) => sum + line.quantity, 0)),
          cost: movementCost(sourceLines, movement.sign),
        },
      };
      await client.query(
        `INSERT INTO tuvansa.inventory_adjustments (id,document_no,request_key,fingerprint,movement,original_movement)
         VALUES($1,$2,$3,$4,$5::jsonb,$5::jsonb)`, [id, number, requestKey, fingerprint, JSON.stringify(saved)],
      );
      await writeDeltas(client, saved, false);
      return saved;
    });
  }

  async canCancel(document: MovementDocument): Promise<string | null> {
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
    }
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
      await this.checkCancellationStock(client, original, true);
      await writeDeltas(client, original, true);
      const canceled: MovementDocument = {
        ...original,
        lines: original.lines.map((line) => ({ ...line, type: 'K', quantity: 0, cost: 0, pieces: 0, piecesText: '' })),
        totals: { quantity: 0, cost: 0 },
      };
      await client.query('UPDATE tuvansa.inventory_adjustments SET movement=$2::jsonb,canceled_at=now() WHERE id=$1', [id, JSON.stringify(canceled)]);
    });
  }
}
