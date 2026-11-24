import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import { ConflictError } from '../../../../../shared/domain/errors/conflict-error.js';
import type { PostgresClient } from '../../../../../shared/infrastructure/database/postgres-pool.js';
import { migratePostgres } from '../../../../../shared/infrastructure/datasources/postgres-schema.js';
import type { MovementLine } from '../../../../inventories/movements/domain/entities/inventory-movement.js';
import {
  allocatePepsExit, currentAdjustmentLayers, groupPepsLayers, lockPepsProducts, reversePepsOrders, writeLayerStock,
} from '../../../../inventories/movements/infrastructure/datasources/inventory-adjustment-layers.js';
import type { MysqlInventoryAdjustmentReferences } from '../../../../inventories/movements/infrastructure/datasources/mysql-inventory-adjustment-references.js';
import { effectivePepsCost, inventoryPepsCostsOn } from '../../../../inventories/movements/infrastructure/datasources/postgres-inventory-peps-cost.js';
import { ensurePurchaseReceptionPepsSchema } from '../../../../purchasing/purchase-receptions/infrastructure/datasources/purchase-reception-peps.js';
import { ensurePurchaseReceptionSchema } from '../../../../purchasing/purchase-receptions/infrastructure/datasources/postgres-purchase-reception-writes.js';
import { roundAmount } from '../../../orders/domain/entities/order-capture-totals.js';
import { scaledStock } from '../../../orders/infrastructure/datasources/sales-order-inventory-stock.js';
import type { InvoiceFromOrderPosting } from '../../domain/datasources/invoice-from-order-data-source.js';

export type SalesRemissionLayerReferences = Pick<MysqlInventoryAdjustmentReferences, 'layers'>;

const migrations = [{ id: 'sales_remission_peps', sql: `
  ALTER TABLE tuvansa.inventory_adjustment_layer_stock
    DROP CONSTRAINT inventory_adjustment_layer_stock_check,
    ADD COLUMN remission_id bigint REFERENCES tuvansa.sales_remissions(id),
    ADD UNIQUE(remission_id,layer_id,reversal),
    ADD CONSTRAINT inventory_layer_stock_origin CHECK (num_nonnulls(adjustment_id,receipt_id,remission_id)=1);
` }];

export async function ensureSalesRemissionPepsSchema(client: PostgresClient) {
  await ensurePurchaseReceptionSchema(client);
  await ensurePurchaseReceptionPepsSchema(client);
  await migratePostgres(client, migrations);
}

export async function allocateSalesRemissionLayers(
  client: PostgresClient, posting: InvoiceFromOrderPosting, references: SalesRemissionLayerReferences,
) {
  const queueChanges = new Map<number, number>();
  const layered = posting.stock.filter(({ pepsCostBasis }) => pepsCostBasis !== undefined);
  if (!layered.length) return { ...posting, queueChanges };
  const ids = layered.map(({ productId }) => productId);
  await lockPepsProducts(client, ids);
  const queue = groupPepsLayers(await currentAdjustmentLayers(client, ids, await references.layers(ids)));
  const snapshots = await inventoryPepsCostsOn(client, ids);
  const costs = new Map(layered.map(({ productId, pepsCostBasis }) => {
    const valuation = effectivePepsCost(pepsCostBasis!, snapshots.get(productId));
    const cost = Number((valuation.average + valuation.adValorem).toFixed(4));
    if (!Number.isFinite(cost) || cost < 0) throw new ApplicationError(
      'El costo promedio PEPS del producto no está disponible.', 'SALES_REMISSION_INVALID_PEPS_COST', 422,
    );
    return [productId, cost] as const;
  }));

  const lines = posting.movement.lines.flatMap((movement, index) => {
    const invoice = posting.invoice.lines[index]!;
    const effect = posting.lineEffects[index]!;
    const cost = costs.get(movement.productId);
    if (cost === undefined) return [{ movement, invoice, effect }];
    let fulfilled = 0;
    let billed = 0;
    // MCPAR03/33–37. Cada partida conserva el costo promedio y su liga a la capa.
    return allocatePepsExit({ ...movement, cost }, queue.get(movement.productId) ?? [], queueChanges).map(({ line, layer }) => {
      const quantity = -line.quantity;
      fulfilled = scaledStock(fulfilled + quantity);
      const cumulativeAmount = roundAmount(fulfilled * invoice.price);
      const amount = roundAmount(cumulativeAmount - billed);
      billed = cumulativeAmount;
      const { id, warehouse, date, lot, customsEntry, customsOffice, number, expiresAt } = layer;
      return {
        movement: line,
        invoice: { ...invoice, cost, quantity: -quantity, fulfilledQuantity: quantity, amount,
          inventoryLayer: { id, warehouse, date, lot, customsEntry, customsOffice, number, expiresAt } },
        effect: { ...effect, quantity },
      };
    });
  });
  return {
    ...posting, queueChanges,
    invoice: { ...posting.invoice, lines: lines.map(({ invoice }) => invoice) },
    movement: { ...posting.movement, lines: lines.map(({ movement }) => movement),
      totals: { ...posting.movement.totals, cost: roundAmount(lines.reduce((sum, { movement }) => sum + movement.quantity * movement.cost, 0)) } },
    lineEffects: lines.map(({ effect }) => effect),
  };
}

export async function restoreSalesRemissionLayers(
  client: PostgresClient, id: number, lines: MovementLine[], references: SalesRemissionLayerReferences,
) {
  const tracked = lines.filter(({ lotId }) => lotId > 0);
  if (!tracked.length) return;
  const ids = [...new Set(tracked.map(({ productId }) => productId))];
  await lockPepsProducts(client, ids);
  const { rows } = await client.query<{ id: number; product: number; warehouse: string; quantity: number }>(
    `SELECT layer_id::float8 AS id,product_id::float8 AS product,warehouse,quantity::float8
     FROM tuvansa.inventory_adjustment_layer_stock WHERE remission_id=$1 AND NOT reversal`, [id],
  );
  const posted = new Map(rows.map((row) => [row.id, row]));
  for (const { lotId, lotWarehouse, warehouse, productId, quantity } of tracked) {
    const row = posted.get(lotId);
    if (!row || row.product !== productId || row.warehouse !== (lotWarehouse ?? warehouse)) throw inconsistentLayer();
    row.quantity = scaledStock(row.quantity - quantity);
  }
  if (rows.some(({ quantity }) => quantity !== 0)) throw inconsistentLayer();

  const queueChanges = reversePepsOrders(tracked, await currentAdjustmentLayers(client, ids, await references.layers(ids)));
  await writeLayerStock(client, 'remission_id', id, tracked, true, queueChanges);
}

function inconsistentLayer() {
  return new ConflictError('Las capas PEPS ya no coinciden con la salida original.', 'SALES_REMISSION_CANCELLATION_LAYER_CHANGED');
}
