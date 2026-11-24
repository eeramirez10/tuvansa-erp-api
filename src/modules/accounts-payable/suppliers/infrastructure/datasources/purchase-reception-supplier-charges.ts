import {
  paymentDocumentIdSql, readPurchasePayables,
} from '../../../../purchasing/purchase-receptions/infrastructure/datasources/postgres-purchase-payables.js';
import { readHistoricalReceptionCancellations } from '../../../../purchasing/purchase-receptions/infrastructure/datasources/historical-purchase-reception-cancellation-reads.js';
import { supplierPaymentReversalSql, type PurchasePostingReversalReference } from '../../../../purchasing/purchase-receptions/infrastructure/datasources/purchase-posting-reversal-reads.js';
import { supplierPaymentReversalsAvailable } from '../../../../purchasing/purchase-receptions/infrastructure/datasources/purchase-posting-reversal-tables.js';
import { supplierPaymentsAvailable } from './postgres-supplier-payments.js';

const paymentScope = `WHERE ${paymentDocumentIdSql('payment')} = receipt.id AND payment.company_id = receipt.company_id
    AND payment.supplier_id = receipt.supplier_id`;

export async function purchaseReceptionSupplierBalances(supplierIds: number[]): Promise<Map<number, number>> {
  if (supplierIds.length === 0) return new Map();
  const localBalances = readPurchasePayables<{ supplierId: number; balance: number; reassignedCancellations: number[] }[]>([], async (client, source) => {
    const hasPayments = await supplierPaymentsAvailable(client);
    const reversal = supplierPaymentReversalSql(hasPayments && await supplierPaymentReversalsAvailable(client));
    const paid = hasPayments ? `coalesce((SELECT ${reversal.paid}
      FROM tuvansa.supplier_payments AS payment ${reversal.join} ${paymentScope}), 0)` : '0';
    const { rows } = await client.query<{ supplierId: number; balance: number; reassignedCancellations: number[] }>(
      `SELECT receipt.supplier_id::float8 AS "supplierId",
         sum(CASE WHEN receipt.cancelled THEN 0 ELSE receipt.principal-receipt.documented_amount-${paid} END)::float8 AS balance,
         coalesce(array_agg(receipt.id::float8) FILTER (WHERE receipt.historical_transfer_in AND receipt.cancelled),
           ARRAY[]::float8[]) AS "reassignedCancellations"
       FROM (${source}) AS receipt
       WHERE receipt.company_id=1 AND (receipt.principal>0 OR receipt.historical_documentation OR receipt.historical_transfer_out)
         AND (NOT receipt.cancelled OR receipt.historical_transfer_in)
         AND receipt.supplier_id=ANY($1::bigint[])
       GROUP BY receipt.supplier_id`, [supplierIds],
    );
    return rows;
  });
  const [local, historical] = await Promise.all([localBalances, readHistoricalReceptionCancellations({ supplierIds })]);
  const balances = new Map(local.map(({ supplierId, balance }) => [supplierId, balance]));
  const reassignedCancellations = new Set(local.flatMap((row) => row.reassignedCancellations));
  for (const { receiptId, supplierId, amount } of historical) {
    if (reassignedCancellations.has(receiptId)) continue;
    balances.set(supplierId, (balances.get(supplierId) ?? 0) - amount);
  }
  return balances;
}

export interface SupplierPurchaseReceptionPayment {
  id: number;
  amount: number;
  date: string;
  number: string;
  policyNumber: string;
  userId: number;
  createdAt: string;
  reversal: PurchasePostingReversalReference | null;
}

export interface SupplierPurchaseReceptionCharge {
  id: number;
  company: number;
  number: string;
  date: string | null;
  dueAt: string | null;
  supplierReference: string;
  orderNumber: string;
  movementType: string;
  userId: number;
  principal: number;
  currencyId: number;
  exchangeRate: number;
  policyNumber: string | null;
  policyId: number | null;
  remaining: number;
  payments: SupplierPurchaseReceptionPayment[];
  days: number;
  createdAt: string;
  cancellation: PurchasePostingReversalReference | null;
  documentation: {
    id: number;
    sourceId: number;
    amount: number;
    date: string;
    userId: number;
    createdAt: string;
  } | null;
  historicalDocumentation: boolean;
  canPay: boolean;
  historicalTransferIn: boolean;
  historicalTransferOut: boolean;
  sourceMovementId: number | null;
}

export async function purchaseReceptionSupplierCharges(supplierId: number): Promise<SupplierPurchaseReceptionCharge[]> {
  return readPurchasePayables<SupplierPurchaseReceptionCharge[]>([], async (client, source) => {
    const hasPayments = await supplierPaymentsAvailable(client);
    const reversal = supplierPaymentReversalSql(hasPayments && await supplierPaymentReversalsAvailable(client));
    const paid = hasPayments ? 'coalesce(payments.amount, 0)' : '0';
    const items = hasPayments ? "coalesce(payments.items, '[]'::jsonb)" : "'[]'::jsonb";
    const join = hasPayments ? `LEFT JOIN LATERAL (
      SELECT ${reversal.paid} AS amount, jsonb_agg(
        jsonb_build_object('id', payment.id, 'amount', payment.amount, 'date', payment.date,
          'number', payment.number, 'policyNumber', payment.policy_number,
          'userId', payment.user_id, 'createdAt', payment.created_at::text, 'reversal', ${reversal.reference})
        ORDER BY payment.id
      ) AS items FROM tuvansa.supplier_payments AS payment ${reversal.join} ${paymentScope}
    ) AS payments ON true` : '';
    const { rows } = await client.query<SupplierPurchaseReceptionCharge>(
      `SELECT receipt.id::float8 AS id,receipt.company_id AS company,receipt.number,receipt.received_at::text AS date,
              receipt.due_at::text AS "dueAt",receipt.supplier_reference AS "supplierReference",
              receipt.order_number AS "orderNumber",receipt.movement_type AS "movementType",receipt.user_id AS "userId",
              receipt.principal::float8 AS principal,receipt.currency_id AS "currencyId",
              receipt.exchange_rate::float8 AS "exchangeRate",receipt.policy_number AS "policyNumber",
              receipt.policy_id::float8 AS "policyId",
              (CASE WHEN receipt.cancelled THEN 0 ELSE receipt.principal-receipt.documented_amount-${paid} END)::float8 AS remaining,
              receipt.cancellation,receipt.documentation,receipt.historical_documentation AS "historicalDocumentation",
              receipt.can_pay AS "canPay",receipt.historical_transfer_in AS "historicalTransferIn",
              receipt.historical_transfer_out AS "historicalTransferOut",receipt.source_movement_id::float8 AS "sourceMovementId",
              ${items} AS payments,coalesce(CURRENT_DATE - receipt.due_at,0) AS days,receipt.created_at::text AS "createdAt"
       FROM (${source}) AS receipt ${join}
       WHERE receipt.company_id=1 AND (receipt.principal>0 OR receipt.historical_documentation OR receipt.historical_transfer_out)
         AND (NOT receipt.cancelled OR receipt.cancellation IS NOT NULL) AND receipt.supplier_id=$1
       ORDER BY receipt.id`, [supplierId],
    );
    return rows;
  });
}
