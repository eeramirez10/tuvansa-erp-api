import { PGlite } from '@electric-sql/pglite';
import { expect, it } from 'vitest';
import { ReversePurchasePosting } from '../src/modules/purchasing/purchase-receptions/application/use-cases/reverse-purchase-posting.js';
import type { ExpenseDocument } from '../src/modules/purchasing/purchase-receptions/domain/datasources/purchase-expense-data-source.js';
import type { PostingReversalInput } from '../src/modules/purchasing/purchase-receptions/domain/datasources/purchase-posting-reversal-data-source.js';
import { PostgresPurchaseExpenses } from '../src/modules/purchasing/purchase-receptions/infrastructure/datasources/postgres-purchase-expenses.js';
import { PostgresPurchasePostingReversals } from '../src/modules/purchasing/purchase-receptions/infrastructure/datasources/postgres-purchase-posting-reversals.js';
import type { PostgresConnectionFactory } from '../src/shared/infrastructure/database/postgres-pool.js';

it('reverses a local PP and then cancels its whole GA batch, preserving original rows', async () => {
  const db = new PGlite();
  const connect: PostgresConnectionFactory = async () => ({
    async query<T extends object>(sql: string, values?: unknown[]) {
      if (values) return db.query<T>(sql, values);
      const results = await db.exec(sql);
      return { rows: (results.at(-1)?.rows ?? []) as T[] };
    },
    release() {},
  });
  const expenses = new PostgresPurchaseExpenses(connect, () => true);
  const references = { fiscalWindow: async () => ({ fiscalStart: '2025-01-01', fiscalEnd: '2025-12-31' }) };
  const reversal = new ReversePurchasePosting(new PostgresPurchasePostingReversals(connect, () => true), references);
  const actor = { companyId: 1, userId: 2 };
  const gaDate = '2025-12-01';
  const ppDate = '2025-12-02';
  const correctedDate = '2025-12-03';
  const documents: ExpenseDocument[] = [11, 12].map((supplierId) => ({
    supplierId, supplierCode: String(supplierId).padStart(6, '0'), supplierName: `Proveedor ${supplierId}`,
    reference: `FACT-${supplierId}`, total: 100, base: 100, vat: 0, vatWithholding: 0, incomeWithholding: 0,
    dueDate: gaDate, account: { id: 2, code: '2005002001', name: 'Proveedores' }, lines: [],
  }));
  try {
    const batch = await expenses.commit({
      actor, fingerprint: 'a'.repeat(64), documents, accountingLines: [],
      input: { requestKey: '985cc0d9-d67f-4f72-b162-ba352557217b', date: gaDate, reference: '', beneficiary: '', description: '', lines: [] },
    });
    const [first, second] = batch.documents;
    await db.exec(`CREATE TABLE tuvansa.supplier_payments (
      id bigint PRIMARY KEY, company_id integer, supplier_id bigint, receipt_id bigint,
      expense_id bigint, number text, policy_number text, date date, amount numeric, bank_account_id bigint);
      CREATE TABLE tuvansa.bank_reconciliation_movements (movement_id bigint PRIMARY KEY);`);
    const paymentId = 6900000000000;
    await db.query('INSERT INTO tuvansa.supplier_payments VALUES ($1,1,11,null,$2,$3,$4,$5,27.56,3202)',
      [paymentId, first!.id, 'TW00000001', '2PW00000001', ppDate]);
    const paid = { kind: 'payment' as const, supplierId: 11, paymentId };
    const secondExpense = { kind: 'expense' as const, documentId: second!.id };
    const firstExpense = { kind: 'expense' as const, documentId: first!.id };
    const reversePayment: PostingReversalInput = {
      requestKey: 'cc5ce214-6fc6-4477-bde7-28225bc87828', date: correctedDate, reason: 'Pago duplicado', confirmed: true,
    };
    const cancelExpense: PostingReversalInput = {
      requestKey: '8fc0e087-4899-4134-8f1e-747efa787cad', date: correctedDate, reason: 'Corrige referencia', confirmed: true,
    };

    expect(await reversal.prepare(1, paid)).toMatchObject({ canWrite: true, amount: 27.56, originalDate: ppDate, documents: [{ id: first!.id, total: 100 }] });
    expect(await reversal.prepare(1, secondExpense)).toMatchObject({ canWrite: false, amount: 200, documents: [{ id: first!.id }, { id: second!.id }] });
    const { rows: tableBefore } = await db.query(`SELECT to_regclass('tuvansa.supplier_payment_reversals') AS pp,
      to_regclass('tuvansa.purchase_expense_cancellations') AS ga`);
    expect(tableBefore).toEqual([{ pp: null, ga: null }]);
    await expect(reversal.save(actor, secondExpense, cancelExpense)).rejects.toMatchObject({ code: 'POSTING_REVERSAL_BLOCKED' });
    await expect(reversal.save(actor, paid, { ...reversePayment, date: gaDate })).rejects.toMatchObject({ code: 'POSTING_REVERSAL_INVALID_DATE' });
    await expect(reversal.prepare(1, { ...paid, supplierId: 12 })).rejects.toMatchObject({ code: 'NOT_FOUND' });

    await db.query('INSERT INTO tuvansa.bank_reconciliation_movements(movement_id) VALUES ($1)', [paymentId]);
    expect(await reversal.prepare(1, paid)).toMatchObject({ canWrite: false, reason: 'El pago ya está conciliado en Bancos.' });
    await expect(reversal.save(actor, paid, reversePayment)).rejects.toMatchObject({ code: 'POSTING_REVERSAL_BLOCKED' });
    await db.query('DELETE FROM tuvansa.bank_reconciliation_movements WHERE movement_id=$1', [paymentId]);

    const reversed = await reversal.save(actor, paid, reversePayment);
    expect(reversed).toEqual({ id: 7920000000000, policyNumber: '2RV00000001', date: correctedDate, reason: 'Pago duplicado' });
    expect(await reversal.save(actor, paid, reversePayment)).toEqual(reversed);
    await expect(reversal.save(actor, paid, { ...reversePayment, reason: 'Otra razón' })).rejects.toMatchObject({ code: 'POSTING_REVERSAL_REQUEST_CONFLICT' });
    expect(await reversal.prepare(1, paid)).toMatchObject({ canWrite: false, alreadyRecorded: reversed });

    expect(await reversal.prepare(1, secondExpense)).toMatchObject({ canWrite: true, amount: 200, originalDate: gaDate });
    await expect(reversal.save(actor, secondExpense, { ...cancelExpense, date: ppDate }))
      .rejects.toMatchObject({ code: 'POSTING_REVERSAL_INVALID_DATE' });
    const cancelled = await reversal.save(actor, secondExpense, cancelExpense);
    expect(cancelled).toEqual({ id: 7930000000000, policyNumber: '3GV00000001', date: correctedDate, reason: 'Corrige referencia' });
    expect(await reversal.save(actor, firstExpense, cancelExpense)).toEqual(cancelled);
    expect(await reversal.prepare(1, firstExpense)).toMatchObject({ canWrite: false, alreadyRecorded: cancelled });
    await expect(reversal.save(actor, firstExpense, { ...cancelExpense, requestKey: 'a19067dd-df51-45f7-b1c9-6692c3d5ba98' }))
      .rejects.toMatchObject({ code: 'POSTING_REVERSAL_ALREADY_RECORDED' });

    expect((await db.query('SELECT number,amount::float8 AS amount FROM tuvansa.supplier_payments')).rows).toEqual([{ number: 'TW00000001', amount: 27.56 }]);
    expect((await db.query('SELECT number FROM tuvansa.supplier_payment_reversals')).rows).toEqual([{ number: 'RPW00000001' }]);
    expect((await db.query('SELECT number,amount::float8 AS amount FROM tuvansa.purchase_expense_documents ORDER BY id')).rows)
      .toEqual([{ number: first!.number, amount: 100 }, { number: second!.number, amount: 100 }]);
  } finally { await db.close(); }
}, 15000);
