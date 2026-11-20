import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import type { PostgresClient, PostgresConnectionFactory } from '../../../../../shared/infrastructure/database/postgres-pool.js';
import type { MovementDocument } from '../../domain/entities/inventory-movement.js';

export interface InventoryMovementPolicy {
  warehouseTracking: boolean | null;
  layerEffects: boolean | null;
  transitEffects: boolean | null;
}

export interface InventoryMovementSnapshot {
  policy: InventoryMovementPolicy;
  documents: readonly MovementDocument[];
  products: readonly { productId: number; quantity: string; pieces: string }[];
  warehouses: readonly { productId: number; warehouse: string; quantity: string }[];
}

export const movementTransaction = async <T>(
  connect: PostgresConnectionFactory,
  operation: (client: PostgresClient) => Promise<T>,
): Promise<T> => {
  const client = await connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(715003)');
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

export const readMovementPolicy = async (client: PostgresClient): Promise<InventoryMovementPolicy | undefined> =>
  (await client.query<InventoryMovementPolicy>(
    `SELECT warehouse_tracking AS "warehouseTracking", layer_effects AS "layerEffects",
        transit_effects AS "transitEffects"
     FROM tuvansa.inventory_movement_opening WHERE singleton`,
  )).rows[0];

const validId = (id: number): boolean => Number.isSafeInteger(id) && id > 0;
const validDecimal = (amount: string): boolean =>
  typeof amount === 'string' && /^[+-]?\d{1,24}(?:\.\d{1,12})?$/.test(amount);

const validateSnapshot = (snapshot: InventoryMovementSnapshot): void => {
  const { policy, documents, products, warehouses } = snapshot;
  const validPolicy = [policy.warehouseTracking, policy.layerEffects, policy.transitEffects]
    .every((value) => value === null || typeof value === 'boolean');
  const validProducts = products.every((row) => validId(row.productId)
    && validDecimal(row.quantity) && validDecimal(row.pieces));
  const validWarehouses = warehouses.every((row) => validId(row.productId)
    && row.warehouse !== '' && row.warehouse === row.warehouse.trim() && validDecimal(row.quantity));

  if (!validPolicy || !validProducts || !validWarehouses || products.length === 0) {
    throw new ApplicationError('La copia de apertura contiene saldos o reglas inválidos.', 'INVENTORY_MOVEMENT_SNAPSHOT_INVALID', 409);
  }
  for (const document of documents) {
    const ids = document.lines.map(({ id }) => id);
    if (!validId(document.header.id) || ids.some((id) => !validId(id)) || new Set(ids).size !== ids.length) {
      throw new ApplicationError('La copia de apertura contiene documentos o partidas inválidos.', 'INVENTORY_MOVEMENT_SNAPSHOT_INVALID', 409);
    }
  }
};

// Derivada. La apertura es atómica y se instala una sola vez por base aislada.
export const stageInventoryMovements = async (
  connect: PostgresConnectionFactory,
  snapshot: InventoryMovementSnapshot,
): Promise<void> => {
  validateSnapshot(snapshot);
  await movementTransaction(connect, async (client) => {
    if (await readMovementPolicy(client)) {
      throw new ApplicationError('La base ya cuenta con una apertura de movimientos.', 'INVENTORY_MOVEMENT_SNAPSHOT_EXISTS', 409);
    }
    const { warehouseTracking, layerEffects, transitEffects } = snapshot.policy;
    await client.query(
      `INSERT INTO tuvansa.inventory_movement_opening (warehouse_tracking, layer_effects, transit_effects)
       VALUES ($1, $2, $3)`,
      [warehouseTracking, layerEffects, transitEffects],
    );
    await client.query(
      `INSERT INTO tuvansa.inventory_movement_product_balances (product_id, quantity, pieces)
       SELECT "productId", quantity, pieces
       FROM jsonb_to_recordset($1::jsonb) AS rows("productId" bigint, quantity numeric, pieces numeric)`,
      [JSON.stringify(snapshot.products)],
    );
    await client.query(
      `INSERT INTO tuvansa.inventory_movement_warehouse_balances (product_id, warehouse, quantity)
       SELECT "productId", warehouse, quantity
       FROM jsonb_to_recordset($1::jsonb) AS rows("productId" bigint, warehouse text, quantity numeric)`,
      [JSON.stringify(snapshot.warehouses)],
    );
    for (const document of snapshot.documents) {
      const lines = [...document.lines].sort((first, second) => first.id - second.id);
      await client.query(
        'INSERT INTO tuvansa.inventory_movement_documents (id, original_document) VALUES ($1, $2::jsonb)',
        [document.header.id, JSON.stringify({ ...document, lines })],
      );
    }
  });
};
