import {
  paymentDocumentIdSql, readPurchasePayables,
} from '../../../../purchasing/purchase-receptions/infrastructure/datasources/postgres-purchase-payables.js';
import { supplierPaymentsAvailable } from './postgres-supplier-payments.js';

const paymentScope = `FROM tuvansa.supplier_payments AS payment
  WHERE ${paymentDocumentIdSql('payment')} = receipt.id AND payment.company_id = receipt.company_id
    AND payment.supplier_id = receipt.supplier_id`;

export async function purchaseReceptionSupplierBalances(supplierIds: number[]): Promise<Map<number, number>> {
  if (supplierIds.length === 0) return new Map();
  return readPurchasePayables(new Map<number, number>(), async (client, source) => {
    const hasPayments = await supplierPaymentsAvailable(client);
    const paid = hasPayments ? `coalesce((SELECT sum(payment.amount) ${paymentScope}), 0)` : '0';
    const { rows } = await client.query<{ supplierId: number; balance: number }>(
      `SELECT receipt.supplier_id::float8 AS "supplierId",sum(receipt.principal - ${paid})::float8 AS balance
       FROM (${source}) AS receipt
       WHERE receipt.company_id=1 AND receipt.principal>0 AND NOT receipt.cancelled
         AND receipt.supplier_id=ANY($1::bigint[])
       GROUP BY receipt.supplier_id`, [supplierIds],
    );
    return new Map(rows.map(({ supplierId, balance }) => [supplierId, balance]));
  });
}

export interface SupplierPurchaseReceptionPayment {
  id: number;
  amount: number;
  date: string;
  number: string;
  policyNumber: string;
  userId: number;
  createdAt: string;
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
}

export async function purchaseReceptionSupplierCharges(supplierId: number): Promise<SupplierPurchaseReceptionCharge[]> {
  return readPurchasePayables<SupplierPurchaseReceptionCharge[]>([], async (client, source) => {
    const hasPayments = await supplierPaymentsAvailable(client);
    const paid = hasPayments ? 'coalesce(payments.amount, 0)' : '0';
    const items = hasPayments ? "coalesce(payments.items, '[]'::jsonb)" : "'[]'::jsonb";
    const join = hasPayments ? `LEFT JOIN LATERAL (
      SELECT sum(payment.amount) AS amount, jsonb_agg(
        jsonb_build_object('id', payment.id, 'amount', payment.amount, 'date', payment.date,
          'number', payment.number, 'policyNumber', payment.policy_number,
          'userId', payment.user_id, 'createdAt', payment.created_at::text)
        ORDER BY payment.id
      ) AS items ${paymentScope}
    ) AS payments ON true` : '';
    const { rows } = await client.query<SupplierPurchaseReceptionCharge>(
      `SELECT receipt.id::float8 AS id,receipt.company_id AS company,receipt.number,receipt.received_at::text AS date,
              receipt.due_at::text AS "dueAt",receipt.supplier_reference AS "supplierReference",
              receipt.order_number AS "orderNumber",receipt.movement_type AS "movementType",receipt.user_id AS "userId",
              receipt.principal::float8 AS principal,receipt.currency_id AS "currencyId",
              receipt.exchange_rate::float8 AS "exchangeRate",receipt.policy_number AS "policyNumber",
              receipt.policy_id::float8 AS "policyId",(receipt.principal - ${paid})::float8 AS remaining,
              ${items} AS payments,coalesce(CURRENT_DATE - receipt.due_at,0) AS days,receipt.created_at::text AS "createdAt"
       FROM (${source}) AS receipt ${join}
       WHERE receipt.company_id=1 AND receipt.principal>0 AND NOT receipt.cancelled AND receipt.supplier_id=$1
       ORDER BY receipt.id`, [supplierId],
    );
    return rows;
  });
}
