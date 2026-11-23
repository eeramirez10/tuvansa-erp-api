import { PGlite } from '@electric-sql/pglite';
import { expect, it } from 'vitest';
import { CreatePurchaseExpenses } from '../src/modules/purchasing/purchase-receptions/application/use-cases/create-purchase-expenses.js';
import type { ExpenseInput, ExpenseReferences } from '../src/modules/purchasing/purchase-receptions/domain/datasources/purchase-expense-data-source.js';
import { PostgresPurchaseExpenses } from '../src/modules/purchasing/purchase-receptions/infrastructure/datasources/postgres-purchase-expenses.js';
import type { PostgresConnectionFactory } from '../src/shared/infrastructure/database/postgres-pool.js';

it('applies balanced signed expenses and payable documents once, grouped by supplier, reference, product and cost center', async () => {
  const db = new PGlite();
  const connect: PostgresConnectionFactory = async () => ({
    async query<T extends object>(sql: string, values?: unknown[]) {
      if (values) return db.query<T>(sql, values);
      const results = await db.exec(sql);
      return { rows: (results.at(-1)?.rows ?? []) as T[] };
    },
    release() {},
  });
  const vat = { id: 3, code: '1119001', name: 'IVA' };
  const vatWithholding = { id: 4, code: '2016013', name: 'Retención IVA' };
  const incomeWithholding = { id: 5, code: '2016018', name: 'Retención ISR' };
  let invalidSupplierName = false;
  const references: ExpenseReferences = {
    settings: async () => ({
      fiscalStart: '2025-01-01', fiscalEnd: '2025-12-31', vatRates: [16, 8, 0],
      costCenters: [{ code: '1', name: 'México' }, { code: '2', name: 'Monterrey' }],
      taxAccounts: { vat: [vat], vatWithholding: [vatWithholding], incomeWithholding: [incomeWithholding] },
      defaultTaxAccounts: { vat: null, vatWithholding: null, incomeWithholding: null },
    }),
    supplier: async (_companyId, code) => ({
      id: Number(code), code, name: code === '000012' && invalidSupplierName ? 'P'.repeat(81) : `Proveedor ${code}`,
      accountCode: '2005002001', terms: 30, vatType: 0, vatWithholdingRate: 0, incomeWithholdingRate: 0,
    }),
    product: async (code) => ({ id: 20, code, name: 'Gasto', accountCode: '6003507', vatExempt: false, retentionsEligible: true }),
    accounts: async (_companyId, codes) => new Map(codes.map((code, index) => [code, { id: index + 20, code, name: code }])),
    existingReference: async (refs) => refs.includes('LEGACY') ? 'LEGACY' : null,
  };
  const expenses = new CreatePurchaseExpenses(references, new PostgresPurchaseExpenses(connect, () => true));
  const actor = { companyId: 1, userId: 3 };
  const line = { supplierCode: '000011', productCode: '6003507001', costCenter: '1', reference: 'FACT-1' };
  const input: ExpenseInput = {
    requestKey: 'ca561823-69f6-4a43-8e87-b78fbba2b97e', date: '2025-12-31', reference: 'POLIZA-1',
    beneficiary: 'Tuvansa', description: 'Gastos múltiples',
    taxAccounts: { vat: vat.code, vatWithholding: vatWithholding.code, incomeWithholding: incomeWithholding.code },
    lines: [
      { ...line, base: 100.21, vat: 16.03, vatWithholding: 4.25, incomeWithholding: 1.25 },
      { ...line, base: -10.21, vat: -1.63, vatWithholding: -0.25, incomeWithholding: 0 },
      { ...line, costCenter: '2', base: 12.45, vat: 0, vatWithholding: 0, incomeWithholding: 0 },
      { ...line, supplierCode: '000012', reference: 'FACT-2', base: 1.02, vat: 0, vatWithholding: 0, incomeWithholding: 0 },
    ],
  };
  try {
    await expect(expenses.save(actor, { ...input, taxAccounts: undefined })).rejects.toMatchObject({ code: 'PURCHASE_EXPENSE_UNSUPPORTED' });
    const result = await expenses.save(actor, input);
    expect(result.documents).toMatchObject([
      { id: 7910000000000, number: 'GAW00000001', total: 111.6 },
      { id: 7910000000001, number: 'GAW00000002', total: 1.02 },
    ]);
    expect(result.policyNumber).toBe('3GW00000001');
    expect(await expenses.save(actor, input)).toEqual(result);
    await expect(expenses.save(actor, { ...input, description: 'Cambio' })).rejects.toMatchObject({ code: 'PURCHASE_EXPENSE_REQUEST_CONFLICT' });

    const next = { ...input, requestKey: 'a39db094-a8b8-47f8-b6cc-cbf6055ebfb5' };
    await expect(expenses.save(actor, { ...next, lines: next.lines.map((item) => ({ ...item, reference: item.reference.toLowerCase() })) }))
      .rejects.toMatchObject({ code: 'PURCHASE_EXPENSE_REFERENCE_CONFLICT' });
    await expect(expenses.save(actor, { ...next, lines: [{ ...next.lines[0]!, reference: 'LEGACY' }] }))
      .rejects.toMatchObject({ code: 'PURCHASE_EXPENSE_REFERENCE_CONFLICT' });
    invalidSupplierName = true;
    await expect(expenses.save(actor, { ...next, lines: next.lines.map((item) => ({ ...item, reference: `Z${item.reference}` })) }))
      .rejects.toMatchObject({ code: 'PURCHASE_EXPENSE_POSTGRES_UNAVAILABLE' });

    const { rows: documents } = await db.query('SELECT supplier_account, date::text, due_date::text, lines FROM tuvansa.purchase_expense_documents ORDER BY id');
    expect(documents).toMatchObject([
      { supplier_account: '2005002001', date: '2025-12-31', due_date: '2026-01-30', lines: [{ costCenter: '1', base: 90, vat: 14.4 }, { costCenter: '2', base: 12.45 }] },
      { supplier_account: '2005002001', date: '2025-12-31', due_date: '2026-01-30', lines: [{ costCenter: '1', base: 1.02 }] },
    ]);
    const { rows } = await db.query(`SELECT sum((line->>'debit')::numeric)::text AS debit,
      sum((line->>'credit')::numeric)::text AS credit FROM tuvansa.purchase_expense_batches, jsonb_array_elements(accounting_lines) AS line`);
    expect(rows).toEqual([{ debit: '118.12', credit: '118.12' }]);
    expect((await db.query('SELECT id FROM tuvansa.purchase_expense_batches')).rows).toHaveLength(1);
  } finally { await db.close(); }
}, 15000);
