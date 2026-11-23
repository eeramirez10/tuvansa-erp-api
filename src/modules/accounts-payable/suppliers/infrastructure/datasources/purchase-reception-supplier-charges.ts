import {
  readLocalPurchaseReceptions, type LocalReceptionRecord,
} from '../../../../purchasing/purchase-receptions/infrastructure/datasources/postgres-purchase-reception-writes.js';
import { supplierPaymentsAvailable } from './postgres-supplier-payments.js';

interface ReceiptSupplierBalance {
  supplierId: number;
  balance: number;
}

const supplierIdField = "(receipt.result #>> '{reception,supplier,id}')::bigint";
const originalAmount = "(receipt.payable->>'amount')::numeric";
const paymentScope = `FROM tuvansa.supplier_payments AS payment
  WHERE payment.receipt_id = receipt.id AND payment.company_id = receipt.company_id
    AND payment.supplier_id = ${supplierIdField}`;

export async function purchaseReceptionSupplierBalances(supplierIds: number[]): Promise<Map<number, number>> {
  if (supplierIds.length === 0) return new Map();
  return readLocalPurchaseReceptions(new Map<number, number>(), async (client) => {
    const hasPayments = await supplierPaymentsAvailable(client);
    const paid = hasPayments ? `coalesce((SELECT sum(payment.amount) ${paymentScope}), 0)` : '0';
    // Derivada. Suma cada cargo menos sus pagos en la compañía del panel.
    const { rows } = await client.query<ReceiptSupplierBalance>(
      `SELECT ${supplierIdField}::float8 AS "supplierId",
              sum(${originalAmount} - ${paid})::float8 AS balance
       FROM tuvansa.purchase_receptions AS receipt
       WHERE receipt.company_id = 1 AND receipt.payable IS NOT NULL
         AND ${supplierIdField} = ANY($1::bigint[])
       GROUP BY ${supplierIdField}`, [supplierIds],
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

export type SupplierPurchaseReceptionCharge = Pick<LocalReceptionRecord, 'result' | 'movement' | 'accounting'> & {
  payable: NonNullable<LocalReceptionRecord['payable']>;
  remaining: number;
  payments: SupplierPurchaseReceptionPayment[];
  days: number;
  createdAt: string;
};

export async function purchaseReceptionSupplierCharges(supplierId: number): Promise<SupplierPurchaseReceptionCharge[]> {
  return readLocalPurchaseReceptions<SupplierPurchaseReceptionCharge[]>([], async (client) => {
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
    // Derivada. El cargo y sus pagos se leen en la misma instantánea; el importe original se conserva.
    const { rows } = await client.query<SupplierPurchaseReceptionCharge>(
      `SELECT receipt.result, receipt.movement, receipt.payable, receipt.accounting,
              (${originalAmount} - ${paid})::float8 AS remaining, ${items} AS payments,
              CURRENT_DATE - (receipt.payable->>'dueAt')::date AS days, receipt.created_at::text AS "createdAt"
       FROM tuvansa.purchase_receptions AS receipt ${join}
       WHERE receipt.company_id = 1 AND receipt.payable IS NOT NULL
         AND ${supplierIdField} = $1
       ORDER BY receipt.id`, [supplierId],
    );
    return rows;
  });
}
