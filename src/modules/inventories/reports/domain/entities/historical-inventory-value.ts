export type HistoricalInventoryCosts = {
  incoming: string; outgoing: string; dated: string; unlinked: string;
  revaluation: string; undatedRevaluation: string;
  zeroCostMovements: number; undatedZeroCostMovements: number;
};
export type HistoricalInventoryValue = {
  incoming: number; outgoing: number; dated: number; unlinked: number; reported: number;
  revaluation: number; undatedRevaluation: number;
  zeroCostMovements: number; undatedZeroCostMovements: number;
};
// FAXINV: quantity DECIMAL(18,3) × movement cost DECIMAL(18,5).
function scaled(value: string): bigint {
  if (!/^-?\d+(?:\.\d{1,8})?$/.test(value)) throw new Error('Invalid historical inventory amount');
  const negative = value.startsWith('-');
  const [whole, fraction = ''] = value.replace(/^-/, '').split('.');
  const result = BigInt(whole!) * 100_000_000n + BigInt(fraction.padEnd(8, '0'));
  return negative ? -result : result;
}
function money(amount: bigint): number {
  const cents = amount >= 0n ? (amount + 500_000n) / 1_000_000n : -((-amount + 500_000n) / 1_000_000n);
  if (cents > BigInt(Number.MAX_SAFE_INTEGER) || cents < BigInt(Number.MIN_SAFE_INTEGER)) throw new Error('Historical inventory value exceeds supported precision');
  return Number(cents) / 100;
}
export function historicalInventoryValue(costs: HistoricalInventoryCosts, includeUndated: boolean): HistoricalInventoryValue {
  return { incoming: money(scaled(costs.incoming)), outgoing: money(scaled(costs.outgoing)),
    dated: money(scaled(costs.dated)), unlinked: money(scaled(costs.unlinked)),
    reported: money(scaled(costs.dated) + (includeUndated ? scaled(costs.unlinked) : 0n)),
    revaluation: money(scaled(costs.revaluation)), undatedRevaluation: money(scaled(costs.undatedRevaluation)),
    zeroCostMovements: costs.zeroCostMovements, undatedZeroCostMovements: costs.undatedZeroCostMovements };
}
export function sumHistoricalInventoryValues(rows: Array<{ historical: HistoricalInventoryValue }>): HistoricalInventoryValue {
  const total: HistoricalInventoryValue = { incoming: 0, outgoing: 0, dated: 0, unlinked: 0, reported: 0,
    revaluation: 0, undatedRevaluation: 0, zeroCostMovements: 0, undatedZeroCostMovements: 0 };
  for (const { historical } of rows) for (const key of Object.keys(total) as Array<keyof HistoricalInventoryValue>) {
    total[key] = key === 'zeroCostMovements' || key === 'undatedZeroCostMovements'
      ? total[key] + historical[key] : (Math.round(total[key] * 100) + Math.round(historical[key] * 100)) / 100;
  }
  return total;
}
