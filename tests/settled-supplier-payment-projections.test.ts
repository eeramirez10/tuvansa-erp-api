import { PGlite } from '@electric-sql/pglite';
import { expect, it, vi } from 'vitest';
import { AccountingPoliciesWithLocalPostingsDataSource } from '../src/modules/accounting/policies/infrastructure/datasources/accounting-policies-with-local-postings-data-source.js';
import { LegacyMysqlAccountingPoliciesDataSource } from '../src/modules/accounting/policies/infrastructure/datasources/legacy-mysql-accounting-policies-data-source.js';
import { PostgresPurchaseExpenses } from '../src/modules/purchasing/purchase-receptions/infrastructure/datasources/postgres-purchase-expenses.js';
import { bankReconciliationState } from '../src/modules/treasury/banking/infrastructure/datasources/bank-reconciliation-reads.js';
import { BankPanelsWithLocalPostingsDataSource } from '../src/modules/treasury/banking/infrastructure/datasources/banks-with-local-postings-data-source.js';
import { LegacyMysqlBankAccountsDataSource } from '../src/modules/treasury/banking/infrastructure/datasources/legacy-mysql-bank-accounts-data-source.js';
import { LegacyMysqlBankPanelsDataSource } from '../src/modules/treasury/banking/infrastructure/datasources/legacy-mysql-bank-panels-data-source.js';
import { PostgresBankReconciliations } from '../src/modules/treasury/banking/infrastructure/datasources/postgres-bank-reconciliations.js';
import type { PostgresConnectionFactory } from '../src/shared/infrastructure/database/postgres-pool.js';

const db = new PGlite();
const connect: PostgresConnectionFactory = async () => ({
  async query<T extends object>(sql: string, values?: unknown[]) {
    if (values) return db.query<T>(sql, values);
    const result = await db.exec(sql);
    return { rows: (result.at(-1)?.rows ?? []) as T[] };
  },
  release() {},
});

vi.mock('../src/shared/infrastructure/database/postgres-pool.js', async (importOriginal) => ({
  ...await importOriginal<object>(), connectPostgres: () => connect(), postgresConfigured: () => true,
}));
vi.mock('../src/shared/infrastructure/database/legacy-mysql-pool.js', () => ({ legacyMysqlPool: { query: async () => [[]] } }));

it('lists and independently reconciles only the RP that references the original PP cut', async () => {
  const bankBase = vi.spyOn(LegacyMysqlBankPanelsDataSource.prototype, 'getPanel').mockImplementation(async (_, key) => ({
    button: key, section: 'actions', available: true, readOnly: true, source: [], items: [],
  }));
  const bank = new BankPanelsWithLocalPostingsDataSource(new LegacyMysqlBankAccountsDataSource());
  const accounting = new AccountingPoliciesWithLocalPostingsDataSource(new LegacyMysqlAccountingPoliciesDataSource());
  const reconciliations = new PostgresBankReconciliations(connect);
  const supplierId = 11;
  const bankAccountId = 6610;
  const originalId = 6900000000000;
  const pendingId = 6900000000001;
  const correctionId = 7920000000000;
  const pendingReversalId = 7920000000001;
  const options = { costCenter: '', fiscalYear: 2025, asOfDate: '2025-12-04' };
  const reconcile = (movementId: number, statementDate: string, expectedBankBalance: number, statementBalance: number, accountId = bankAccountId) =>
    reconciliations.commit({ companyId: 1, bankAccountId: accountId, fingerprint: 'e'.repeat(64), bankOpeningBalance: async () => 1000,
      input: { requestKey: crypto.randomUUID(), movementIds: [movementId], statementDate, statementBalance, expectedBankBalance } });

  try {
    const expenses = new PostgresPurchaseExpenses(connect, () => true);
    const expenseDate = '2025-12-01';
    const batch = await expenses.commit({ actor: { companyId: 1, userId: 2 }, fingerprint: 'a'.repeat(64), accountingLines: [],
      documents: [{ supplierId, supplierCode: '000011', supplierName: 'Proveedor de prueba', reference: 'FACT-11',
        total: 100, base: 100, vat: 0, vatWithholding: 0, incomeWithholding: 0, dueDate: expenseDate,
        account: { id: 2, code: '21001', name: 'Proveedores' }, lines: [] }],
      input: { requestKey: crypto.randomUUID(), date: expenseDate, reference: '', beneficiary: '', description: '', lines: [] } });
    await db.exec(`
      CREATE TABLE tuvansa.supplier_payments (
        id bigint PRIMARY KEY, company_id integer, supplier_id bigint, bank_account_id bigint, receipt_id bigint, expense_id bigint,
        number text, policy_number text, date date, amount numeric, description text, user_id integer, mode text,
        bank_code text, bank_name text, supplier_account text, supplier_account_name text, created_at timestamptz DEFAULT now()
      );
      CREATE TABLE tuvansa.supplier_payment_reversals (
        id bigint PRIMARY KEY, company_id integer, payment_id bigint, number text, policy_number text,
        date date, reason text, user_id integer, result jsonb, created_at timestamptz DEFAULT now()
      );
    `);
    await db.query(`
      INSERT INTO tuvansa.supplier_payments
        (id,company_id,supplier_id,bank_account_id,expense_id,number,policy_number,date,amount,description,user_id,mode,
         bank_code,bank_name,supplier_account,supplier_account_name)
      VALUES ($1,1,$3,$4,$5,'TW1','2PW1','2025-12-02',40,'Pago',2,'transfer','1102100001','Banco','21001','Proveedores'),
             ($2,1,$3,$4,$5,'TW2','2PW2','2025-12-02',15,'Pago',2,'transfer','1102100001','Banco','21001','Proveedores')`,
    [originalId, pendingId, supplierId, bankAccountId, batch.documents[0]!.id]);
    const originalCut = await reconcile(originalId, '2025-12-03', 1000, 960);
    const originalReconciliation = { id: originalCut.id, date: originalCut.statementDate };
    await db.query(`
      INSERT INTO tuvansa.supplier_payment_reversals (id,company_id,payment_id,number,policy_number,date,reason,user_id,result)
      VALUES ($1,1,$3,'RPW1','2RV1','2025-12-04','Pago duplicado',2,$5::jsonb),
             ($2,1,$4,'RPW2','2RV2','2025-12-04','Pago pendiente anulado',2,'{}'::jsonb)`,
    [correctionId, pendingReversalId, originalId, pendingId, JSON.stringify({ originalReconciliation })]);

    const originalRow = { movementId: originalId, movementType: 'PP', charge: 0, credit: 40, reconciled: 'X',
      reconciliationId: originalCut.id, statementDate: originalCut.statementDate };
    const correctionRow = { movementId: correctionId, movementType: 'RP', charge: 40, credit: 0 };
    for (const key of ['payments', 'auxiliary'] as const) {
      const listed = await bank.getPanel(bankAccountId, key, options);
      expect(listed.items).toEqual(expect.arrayContaining([
        expect.objectContaining(originalRow), expect.objectContaining({ ...correctionRow, reconciled: '' }),
      ]));
      expect(listed.summary).toMatchObject({ balance: 0, charges: 55, credits: 55 });
    }
    for (const key of ['reconciliation', 'automatic-reconciliation'] as const) {
      const panel = await bank.getPanel(bankAccountId, key, options);
      expect(panel.items).toMatchObject([{ ...correctionRow, canReconcile: true }]);
    }
    expect((await bank.getPanel(bankAccountId, 'automatic-reconciliation', { ...options, asOfDate: '2025-12-03' })).items).toEqual([]);
    expect((await accounting.findById(originalId))?.toPrimitives().movements).toMatchObject([
      { accountId: bankAccountId, debit: 0, credit: 40, reconciled: true }, { debit: 40, credit: 0, reconciled: false },
    ]);
    expect((await accounting.findById(correctionId))?.toPrimitives().movements).toMatchObject([
      { accountId: bankAccountId, debit: 40, credit: 0, reconciled: false }, { debit: 0, credit: 40, reconciled: false },
    ]);
    for (const invalidId of [originalId, pendingId, pendingReversalId]) {
      await expect(reconcile(invalidId, '2025-12-04', 960, 1000)).rejects.toMatchObject({ code: 'BANK_RECONCILIATION_MOVEMENT_UNAVAILABLE' });
    }
    await expect(reconcile(correctionId, '2025-12-04', 1000, 1040, 6699))
      .rejects.toMatchObject({ code: 'BANK_RECONCILIATION_MOVEMENT_UNAVAILABLE' });
    for (const badCut of [{ ...originalReconciliation, date: '2025-12-02' }, { ...originalReconciliation, id: 40 }]) {
      await db.query('UPDATE tuvansa.supplier_payment_reversals SET result=$1::jsonb WHERE id=$2',
        [JSON.stringify({ originalReconciliation: badCut }), correctionId]);
      expect((await bank.getPanel(bankAccountId, 'reconciliation', options)).items).toEqual([]);
      await expect(reconcile(correctionId, '2025-12-04', 960, 1000)).rejects
        .toMatchObject({ code: 'BANK_RECONCILIATION_MOVEMENT_UNAVAILABLE' });
    }
    await db.query('UPDATE tuvansa.supplier_payment_reversals SET result=$1::jsonb WHERE id=$2',
      [JSON.stringify({ originalReconciliation }), correctionId]);
    expect(await bankReconciliationState(await connect(), 1, bankAccountId)).toEqual({ delta: -40, lastStatementDate: '2025-12-03' });

    const correctionCut = await reconcile(correctionId, '2025-12-04', 960, 1000);
    expect(correctionCut).toMatchObject({ netMovement: 40, previousBankBalance: 960, bankBalance: 1000 });
    expect(await bankReconciliationState(await connect(), 1, bankAccountId)).toEqual({ delta: 0, lastStatementDate: '2025-12-04' });
    const settledPayments = await bank.getPanel(bankAccountId, 'payments', options);
    expect(settledPayments.items).toEqual(expect.arrayContaining([
      expect.objectContaining(originalRow),
      expect.objectContaining({ ...correctionRow, reconciled: 'X', statementDate: '2025-12-04', reconciliationId: correctionCut.id }),
    ]));
    expect((await bank.getPanel(bankAccountId, 'reconciliation', options)).items).toEqual([]);
    expect((await accounting.findById(correctionId))?.toPrimitives().movements).toMatchObject([
      { accountId: bankAccountId, debit: 40, credit: 0, reconciled: true }, { debit: 0, credit: 40, reconciled: false },
    ]);
    await expect(reconcile(correctionId, '2025-12-04', 1000, 1040))
      .rejects.toMatchObject({ code: 'BANK_RECONCILIATION_MOVEMENT_UNAVAILABLE' });
    expect((await db.query(`SELECT movement_id::float8,reconciliation_id::float8
      FROM tuvansa.bank_reconciliation_movements ORDER BY movement_id`)).rows).toEqual([
      { movement_id: originalId, reconciliation_id: originalCut.id }, { movement_id: correctionId, reconciliation_id: correctionCut.id },
    ]);
  } finally {
    bankBase.mockRestore();
    await db.close();
  }
}, 20000);
