import { postgresConfigured } from '../../../../../shared/infrastructure/database/postgres-pool.js';
import { supplierPaymentsAvailable } from '../../../../accounts-payable/suppliers/infrastructure/datasources/postgres-supplier-payments.js';
import { isLocalPurchaseReceptionId, readLocalPurchaseReceptions } from '../../../../purchasing/purchase-receptions/infrastructure/datasources/postgres-purchase-reception-writes.js';
import type { BankSupplierExpenseReceipt, BankSupplierExpenseReceipts } from '../../domain/datasources/bank-supplier-expense-data-source.js';

export class PostgresBankSupplierExpenseReceipts implements BankSupplierExpenseReceipts {
  writable(): boolean { return postgresConfigured(); }

  pending(companyId: number): Promise<BankSupplierExpenseReceipt[]> {
    return readLocalPurchaseReceptions<BankSupplierExpenseReceipt[]>([], async (client) => {
      const withPayments = await supplierPaymentsAvailable(client);
      const payments = withPayments ? `CROSS JOIN LATERAL (
        SELECT coalesce(sum(amount),0) AS amount, (count(*)+1)::integer AS revision
        FROM tuvansa.supplier_payments WHERE receipt_id = receipt.id
      ) AS paid` : 'CROSS JOIN (SELECT 0::numeric AS amount,1::integer AS revision) AS paid';
      // Derivada. Lista el saldo y la revisión vigente con las mismas condiciones del pago de recepciones.
      const { rows } = await client.query<BankSupplierExpenseReceipt>(
        `WITH pending AS (
          SELECT receipt.id::float8 AS "receiptId", receipt.number AS "receiptNumber",
                 (receipt.result #>> '{reception,supplier,id}')::bigint::float8 AS "supplierId",
                 receipt.result #>> '{reception,supplier,code}' AS "supplierCode",
                 receipt.result #>> '{reception,supplier,name}' AS "supplierName",
                 receipt.result #>> '{reception,dates,receivedAt}' AS "receivedAt",
                 ((receipt.payable->>'amount')::numeric - paid.amount)::float8 AS remaining, paid.revision
          FROM tuvansa.purchase_receptions AS receipt ${payments}
          WHERE receipt.company_id=$1 AND receipt.number LIKE 'RW%'
            AND (receipt.payable->>'currencyId')::integer = 1 AND (receipt.payable->>'exchangeRate')::numeric = 1
            AND NOT coalesce((receipt.result #>> '{reception,cancelled}')::boolean,false)
        )
        SELECT * FROM pending WHERE remaining > 0 AND "receivedAt" <> '' AND "supplierId" > 0
        ORDER BY "receivedAt" DESC,"receiptId" DESC`, [companyId],
      );
      return rows.filter(({ receiptId }) => isLocalPurchaseReceptionId(receiptId));
    });
  }
}
