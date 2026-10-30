export type InventoryValuation = { dated: number; unlinked: number; reported: number; unpricedProducts: number };
export type InventoryValueCell = { warehouse: string; amount: number; percentage: number | null };

// Quantity: three decimals; ILISTA4: four. Value each product/warehouse in cents.
function value(quantity: number, cost: number): number {
  const scaled = BigInt(Math.round(quantity * 1000)) * BigInt(Math.round(cost * 10000));
  const cents = scaled >= 0n ? (scaled + 50_000n) / 100_000n : -((-scaled + 50_000n) / 100_000n);
  if (cents > BigInt(Number.MAX_SAFE_INTEGER) || cents < BigInt(Number.MIN_SAFE_INTEGER)) throw new Error('Inventory value exceeds supported precision');
  return Number(cents) / 100;
}
export function valueInventoryProduct(quantity: number, unlinked: number, cost: number | undefined, includeUnlinked: boolean): InventoryValuation {
  if (cost === undefined || !Number.isFinite(cost) || cost <= 0) {
    return { dated: 0, unlinked: 0, reported: 0, unpricedProducts: quantity !== 0 || unlinked !== 0 ? 1 : 0 };
  }
  return { dated: value(quantity, cost), unlinked: value(unlinked, cost),
    reported: value(quantity + (includeUnlinked ? unlinked : 0), cost), unpricedProducts: 0 };
}
export function sumInventoryValues(rows: Array<{ valuation: InventoryValuation }>): InventoryValuation {
  const total: InventoryValuation = { dated: 0, unlinked: 0, reported: 0, unpricedProducts: 0 };
  for (const row of rows) {
    for (const key of ['dated', 'unlinked', 'reported'] as const) total[key] = (Math.round(total[key] * 100) + Math.round(row.valuation[key] * 100)) / 100;
    total.unpricedProducts += row.valuation.unpricedProducts;
  }
  return total;
}
