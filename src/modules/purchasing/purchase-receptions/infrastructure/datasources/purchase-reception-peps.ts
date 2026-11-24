import { ConflictError } from '../../../../../shared/domain/errors/conflict-error.js';
import type { PostgresClient } from '../../../../../shared/infrastructure/database/postgres-pool.js';
import { migratePostgres } from '../../../../../shared/infrastructure/datasources/postgres-schema.js';
import { ensureInventoryAdjustmentSchema } from '../../../../inventories/movements/infrastructure/datasources/postgres-inventory-adjustments.js';
import type { InventoryPepsCost } from '../../../../inventories/movements/domain/entities/inventory-peps-cost.js';
import type { InventoryPepsCostSnapshot } from '../../../../inventories/movements/infrastructure/datasources/postgres-inventory-peps-cost.js';
import type { ReceiptCancellationStock } from '../../domain/datasources/purchase-reception-cancellation-data-source.js';

const migrations = [{ id: 'purchase_reception_peps', sql: `
  ALTER TABLE tuvansa.inventory_adjustment_layer_stock
    DROP CONSTRAINT inventory_adjustment_layer_stock_pkey,
    ALTER COLUMN adjustment_id DROP NOT NULL,
    ADD COLUMN receipt_id bigint REFERENCES tuvansa.purchase_receptions(id),
    ADD PRIMARY KEY(event_id),
    ADD CHECK ((adjustment_id IS NULL) <> (receipt_id IS NULL)),
    ADD UNIQUE(adjustment_id,layer_id,reversal),
    ADD UNIQUE(receipt_id,layer_id,reversal);
  ALTER TABLE tuvansa.inventory_adjustment_layers
    DROP CONSTRAINT inventory_adjustment_layers_initial_check,
    ADD CHECK (initial >= 0);
  CREATE TABLE tuvansa.inventory_peps_costs (
    product_id bigint PRIMARY KEY,
    receipt_id bigint NOT NULL REFERENCES tuvansa.purchase_receptions(id),
    basis jsonb NOT NULL,
    effective jsonb NOT NULL
  );
` }];

export async function ensurePurchaseReceptionPepsSchema(client: PostgresClient) {
  await ensureInventoryAdjustmentSchema(client);
  await migratePostgres(client, migrations);
}

export async function receivedPepsCost(
  client: PostgresClient, previous: InventoryPepsCost, opening: number, quantity: number, price: number,
) {
  // MBASE/41, arancel y gastos de pedimento en cero. FINV usa 4 decimales en listas y 2 en advalorem.
  const { rows: [cost] } = await client.query<InventoryPepsCost>(
    `SELECT round($5::numeric,4)::float8 AS last,
       round(CASE WHEN $3::numeric+$4::numeric>0 THEN ($1::numeric*$3+$5*$4)/($3+$4) ELSE $5 END,4)::float8 AS average,
       round(CASE WHEN $3+$4>0 THEN ($2::numeric*$3)/($3+$4) ELSE 0 END,2)::float8 AS "adValorem"`,
    [previous.average, previous.adValorem, opening, quantity, price],
  );
  return cost!;
}

export async function saveReceiptPepsCosts(client: PostgresClient, id: number, costs: Map<number, InventoryPepsCostSnapshot>) {
  for (const [product, { basis, effective }] of costs) {
    await client.query(
      `INSERT INTO tuvansa.inventory_peps_costs (product_id,receipt_id,basis,effective) VALUES ($1,$2,$3::jsonb,$4::jsonb)
       ON CONFLICT (product_id) DO UPDATE SET receipt_id=EXCLUDED.receipt_id,basis=EXCLUDED.basis,effective=EXCLUDED.effective`,
      [product, id, JSON.stringify(basis), JSON.stringify(effective)],
    );
  }
}

export async function verifyReceiptLayerStock(client: PostgresClient, { warehouse, layers }: ReceiptCancellationStock) {
  if (!layers) return;
  const { rows } = await client.query<{ id: string; product: string; warehouse: string; initial: string; posted: string; available: string }>(
    `SELECT l.id,l.product_id AS product,l.warehouse,l.initial,s.quantity AS posted,
       (SELECT COALESCE(sum(history.quantity),0) FROM tuvansa.inventory_adjustment_layer_stock history
        WHERE history.layer_id=l.id AND history.product_id=l.product_id AND history.warehouse=l.warehouse) AS available
     FROM tuvansa.inventory_adjustment_layer_stock s
     JOIN tuvansa.inventory_adjustment_layers l ON l.id=s.layer_id AND l.product_id=s.product_id AND l.warehouse=s.warehouse
     WHERE s.receipt_id=$1 AND NOT s.reversal`, [layers.receiptId],
  );
  const sources = new Map(rows.map((row) => [Number(row.id), row]));
  if (sources.size !== layers.lines.length) throw new ConflictError(
    'Las capas de la recepción no coinciden con su movimiento original.', 'PURCHASE_RECEPTION_CANCELLATION_LAYER_CHANGED',
  );
  for (const line of layers.lines) {
    const layer = sources.get(line.lotId);
    if (!layer || Number(layer.product) !== line.productId || layer.warehouse !== warehouse
      || Number(layer.initial) !== line.quantity || Number(layer.posted) !== line.quantity) {
      throw new ConflictError('Una capa de la recepción cambió desde el alta.', 'PURCHASE_RECEPTION_CANCELLATION_LAYER_CHANGED');
    }
    if (Number(layer.available) < line.quantity) throw new ConflictError(
      `La capa ${line.lotId} ya se utilizó y su saldo no cubre la recepción.`, 'PURCHASE_RECEPTION_CANCELLATION_LAYER_INSUFFICIENT',
    );
  }
}
