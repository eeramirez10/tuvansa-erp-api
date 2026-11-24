import { connectPostgres, postgresConfigured, type PostgresClient } from '../../../../../shared/infrastructure/database/postgres-pool.js';
import type { InventoryPepsCost } from '../../domain/entities/inventory-peps-cost.js';

export interface InventoryPepsCostSnapshot {
  basis: InventoryPepsCost;
  effective: InventoryPepsCost;
}

export function effectivePepsCost(basis: InventoryPepsCost, previous?: InventoryPepsCostSnapshot): InventoryPepsCost {
  return {
    average: previous?.basis.average === basis.average ? previous.effective.average : basis.average,
    last: previous?.basis.last === basis.last ? previous.effective.last : basis.last,
    adValorem: previous?.basis.adValorem === basis.adValorem ? previous.effective.adValorem : basis.adValorem,
  };
}

export async function inventoryPepsCostsOn(client: PostgresClient, ids: number[]) {
  if (!ids.length) return new Map<number, InventoryPepsCostSnapshot>();
  const { rows: [table] } = await client.query<{ available: boolean }>(
    "SELECT to_regclass('tuvansa.inventory_peps_costs') IS NOT NULL AS available",
  );
  if (!table?.available) return new Map<number, InventoryPepsCostSnapshot>();
  const { rows } = await client.query<InventoryPepsCostSnapshot & { id: string }>(
    'SELECT product_id AS id,basis,effective FROM tuvansa.inventory_peps_costs WHERE product_id=ANY($1::bigint[])', [ids],
  );
  return new Map(rows.map(({ id, basis, effective }) => [Number(id), { basis, effective }]));
}

export async function inventoryPepsCosts(ids: number[]) {
  if (!postgresConfigured() || !ids.length) return new Map<number, InventoryPepsCostSnapshot>();
  const client = await connectPostgres();
  try { return await inventoryPepsCostsOn(client, ids); } finally { client.release(); }
}
