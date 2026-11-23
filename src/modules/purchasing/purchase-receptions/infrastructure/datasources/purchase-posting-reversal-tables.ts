import type { PostgresClient } from '../../../../../shared/infrastructure/database/postgres-pool.js';

export const supplierPaymentReversalIdStart = 7920000000000;
export const purchaseExpenseCancellationIdStart = 7930000000000;
export const postingReversalSeriesLength = 99999999;

const inSeries = (id: number, start: number) => id >= start && id < start + postingReversalSeriesLength;
export const isLocalPurchaseExpenseCancellationId = (id: number) => inSeries(id, purchaseExpenseCancellationIdStart);
export const isLocalSupplierPaymentReversalId = (id: number) => inSeries(id, supplierPaymentReversalIdStart);

export async function supplierPaymentReversalsAvailable(client: PostgresClient): Promise<boolean> {
  const { rows: [row] } = await client.query<{ available: boolean }>(
    "SELECT to_regclass('tuvansa.supplier_payment_reversals') IS NOT NULL AS available",
  );
  return row?.available ?? false;
}

export async function purchaseExpenseCancellationsAvailable(client: PostgresClient): Promise<boolean> {
  const { rows: [row] } = await client.query<{ available: boolean }>(
    "SELECT to_regclass('tuvansa.purchase_expense_cancellations') IS NOT NULL AS available",
  );
  return row?.available ?? false;
}
