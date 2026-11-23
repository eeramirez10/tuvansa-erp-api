import { PGlite } from '@electric-sql/pglite';
import { expect, it } from 'vitest';
import { CaptureSupplierPayment } from '../src/modules/accounts-payable/suppliers/application/use-cases/capture-supplier-payment.js';
import { PostgresSupplierPayments } from '../src/modules/accounts-payable/suppliers/infrastructure/datasources/postgres-supplier-payments.js';
import { ensurePurchaseExpenseSchema } from '../src/modules/purchasing/purchase-receptions/infrastructure/datasources/postgres-purchase-expenses.js';
import type { PostgresClient } from '../src/shared/infrastructure/database/postgres-pool.js';

it('pays a GA in a PostgreSQL database with no RW receptions yet', async () => {
  const database = new PGlite();
  const client: PostgresClient = {
    async query<T extends object>(sql: string, values?: unknown[]) {
      if (values) return database.query<T>(sql, values);
      const results = await database.exec(sql);
      return { rows: (results.at(-1)?.rows ?? []) as T[] };
    },
    release() {},
  };

  try {
    await ensurePurchaseExpenseSchema(client);
    await database.exec(`
      INSERT INTO tuvansa.purchase_expense_batches
        (id,company_id,user_id,request_key,fingerprint,policy_number,date,reference,beneficiary,description,accounting_lines,result)
      VALUES (7900000000000,1,0,'3a0e733b-c0a7-4efc-8c08-27b74754c396',repeat('a',64),
              '3GW00000001','2025-12-31','','','','[]','{}');
      INSERT INTO tuvansa.purchase_expense_documents
        (id,batch_id,company_id,supplier_id,supplier_code,supplier_name,supplier_account,supplier_account_name,
         number,reference,date,due_date,amount,base,vat,vat_withholding,income_withholding,lines)
      VALUES (7910000000000,7900000000000,1,719,'000043','Proveedor','2005002001','Pasivo',
              'GAW00000001','TESTGA','2025-12-31','2026-01-31',116,100,16,0,0,'[]');
    `);
    const storage = new PostgresSupplierPayments(async () => client, () => true);
    const payment = new CaptureSupplierPayment(storage, {
      async settings(_companyId, _supplierId, _bankId, _lookup, liability) {
        expect(liability).toEqual({ code: '2005002001', name: 'Pasivo' });
        return {
          policyType: '2', supplierAccount: liability!.code, supplierAccountName: liability!.name,
          bankAccounts: [{ id: 6610, code: '1102100001', name: 'Banco' }],
        };
      },
    });
    const identity = { companyId: 1, supplierId: 719, receiptId: 7910000000000 };
    const initial = await payment.prepare(identity);
    expect(initial).toMatchObject({ canWrite: true, remaining: 116, revision: 1 });

    const input = {
      requestKey: 'a5acd018-4df2-4e3a-8ab5-1aaaf52cb70c',
      revision: initial.revision, bankAccountId: 6610, mode: 'transfer' as const,
      amount: 30, date: '2025-12-31', description: 'Pago parcial GA',
    };
    const saved = await payment.save(identity, 0, input);
    expect(saved).toMatchObject({ receiptId: identity.receiptId, receiptNumber: 'GAW00000001', remaining: 86 });
    expect(await payment.save(identity, 0, input)).toEqual(saved);
    expect(await payment.prepare(identity)).toMatchObject({ revision: 2, remaining: 86 });
    expect(await storage.target({ ...identity, supplierId: 720 })).toBeNull();
    const { rows } = await client.query(
      'SELECT receipt_id,expense_id::float8 AS expense_id,supplier_account FROM tuvansa.supplier_payments',
    );
    expect(rows).toEqual([{ receipt_id: null, expense_id: identity.receiptId, supplier_account: '2005002001' }]);
  } finally {
    await database.close();
  }
}, 15_000);
