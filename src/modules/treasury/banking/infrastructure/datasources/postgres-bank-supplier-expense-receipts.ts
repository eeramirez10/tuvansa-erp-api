import { postgresConfigured } from '../../../../../shared/infrastructure/database/postgres-pool.js';
import { supplierPaymentsAvailable } from '../../../../accounts-payable/suppliers/infrastructure/datasources/postgres-supplier-payments.js';
import { paymentDocumentIdSql, readPurchasePayables } from '../../../../purchasing/purchase-receptions/infrastructure/datasources/postgres-purchase-payables.js';
import { supplierPaymentReversalSql } from '../../../../purchasing/purchase-receptions/infrastructure/datasources/purchase-posting-reversal-reads.js';
import { supplierPaymentReversalsAvailable } from '../../../../purchasing/purchase-receptions/infrastructure/datasources/purchase-posting-reversal-tables.js';
import type { BankSupplierExpenseReceipt, BankSupplierExpenseReceipts } from '../../domain/datasources/bank-supplier-expense-data-source.js';

export class PostgresBankSupplierExpenseReceipts implements BankSupplierExpenseReceipts {
  writable(): boolean { return postgresConfigured(); }

  pending(companyId: number): Promise<BankSupplierExpenseReceipt[]> {
    return readPurchasePayables<BankSupplierExpenseReceipt[]>([], async (client, payables) => {
      const withPayments = await supplierPaymentsAvailable(client);
      const reversal = supplierPaymentReversalSql(withPayments && await supplierPaymentReversalsAvailable(client));
      const payments = withPayments ? `CROSS JOIN LATERAL (
        SELECT coalesce(${reversal.paid},0) AS amount, ${reversal.revision} AS revision
        FROM tuvansa.supplier_payments AS payment ${reversal.join}
        WHERE ${paymentDocumentIdSql('payment')}=receipt.id AND payment.company_id=receipt.company_id AND payment.supplier_id=receipt.supplier_id
      ) AS paid` : 'CROSS JOIN (SELECT 0::numeric AS amount,1::integer AS revision) AS paid';
      // Derivada. Lista el saldo y la revisión vigente con las mismas condiciones del pago de recepciones.
      const { rows } = await client.query<BankSupplierExpenseReceipt>(
        `WITH pending AS (
          SELECT receipt.id::float8 AS "receiptId", receipt.number AS "receiptNumber",
                 receipt.supplier_id::float8 AS "supplierId",receipt.supplier_code AS "supplierCode",
                 receipt.supplier_name AS "supplierName",receipt.received_at::text AS "receivedAt",
                 (receipt.principal - paid.amount)::float8 AS remaining, paid.revision
          FROM (${payables}) AS receipt ${payments}
          WHERE receipt.company_id=$1 AND receipt.currency_id=1 AND receipt.exchange_rate=1 AND NOT receipt.cancelled
        )
        SELECT * FROM pending WHERE remaining > 0 AND "receivedAt" IS NOT NULL AND "supplierId" > 0
        ORDER BY "receivedAt" DESC,"receiptId" DESC`, [companyId],
      );
      return rows;
    });
  }
}
