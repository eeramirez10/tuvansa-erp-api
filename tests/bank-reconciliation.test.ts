import { PGlite } from '@electric-sql/pglite';
import { expect, it } from 'vitest';
import { CaptureBankReconciliation } from '../src/modules/treasury/banking/application/use-cases/capture-bank-reconciliation.js';
import { BankAccount } from '../src/modules/treasury/banking/domain/entities/bank-account.js';
import { bankReconciliationState } from '../src/modules/treasury/banking/infrastructure/datasources/bank-reconciliation-reads.js';
import { PostgresBankReconciliations } from '../src/modules/treasury/banking/infrastructure/datasources/postgres-bank-reconciliations.js';
import type { PostgresConnectionFactory } from '../src/shared/infrastructure/database/postgres-pool.js';

it('reconciles applied income and expense atomically against the statement', async () => {
  const db = new PGlite();
  const connect: PostgresConnectionFactory = async () => ({
    query: async <T extends object>(sql: string, values?: unknown[]) => {
      if (values) return db.query<T>(sql, values);
      const results = await db.exec(sql);
      return { rows: (results.at(-1)?.rows ?? []) as T[] };
    },
    release() {},
  });
  try {
    await db.exec(`
      CREATE SCHEMA tuvansa;
      CREATE TABLE tuvansa.supplier_payments (id bigint PRIMARY KEY, company_id int, bank_account_id bigint, date date, amount numeric);
      CREATE TABLE tuvansa.customer_collections (id bigint PRIMARY KEY, company_id int, bank_account_id bigint, date date, amount numeric);
      INSERT INTO tuvansa.supplier_payments VALUES (6900000000000,1,6610,'2025-01-02',40), (6900000000001,1,6699,'2025-01-01',50);
      INSERT INTO tuvansa.customer_collections VALUES (7300000000000,1,6610,'2025-01-03',116), (7300000000001,1,6610,'2025-01-01',10);
    `);
    const account = BankAccount.create({
      id: 6610, code: '1102100001', name: 'Banco de prueba', systemType: 'bank', family: '', accountNumber: '',
      branch: '', nature: 'debtor', currency: { id: 1, name: 'PESOS' },
      balances: { current: 1086, bank: 1000, previous: 1000, inTransit: 0 },
      currencyBalances: { current: 1086, month12: 1000, previous: 1000 },
      control: {
        manager: '', phone: '', customerNumber: '', controlEnabled: true, nextCheckNumber: 1,
        nextDepositNumber: 1, nextTransferNumber: 1, subAccounts: false, preventJournalEntries: false,
        format: '', movements: true, budgetable: false, company: 1, deposits: true, payments: true, multiCompany: 1,
      },
      prorationPercentages: { sales: 0, inventory: 0, distribution: 0, advance: 0 },
      fiscalReports: { annualInflationAdjustment: 0, deductibleIetu: false, nonDeductibleVat: false },
      createdAt: null, ledger: { firstPeriod: [], secondPeriod: [] },
    });
    const useCase = new CaptureBankReconciliation(new PostgresBankReconciliations(connect, () => true), {
      findById: async () => account,
    });
    const input = {
      requestKey: crypto.randomUUID(), movementIds: [7300000000000, 6900000000000],
      statementDate: '2025-01-31', statementBalance: 1076, expectedBankBalance: 1000,
    };
    await expect(useCase.save(1, 6699, input)).rejects.toMatchObject({ code: 'BANK_RECONCILIATION_MOVEMENT_UNAVAILABLE' });
    await expect(useCase.save(1, 6610, { ...input, statementDate: '2025-01-01' })).rejects
      .toMatchObject({ code: 'BANK_RECONCILIATION_INVALID_DATE' });
    await expect(useCase.save(1, 6610, { ...input, statementBalance: 1075.99 })).rejects
      .toMatchObject({ code: 'BANK_RECONCILIATION_STATEMENT_DIFFERENCE' });
    expect(await bankReconciliationState(await connect(), 1, 6610)).toEqual({ delta: 0, lastStatementDate: null });
    const { rows: before } = await db.query('SELECT count(*)::int AS count FROM tuvansa.bank_reconciliation_movements');
    expect(before).toEqual([{ count: 0 }]);

    const saved = await useCase.save(1, 6610, input);
    expect(saved).toMatchObject({
      movementIds: [6900000000000, 7300000000000], previousBankBalance: 1000, netMovement: 76, bankBalance: 1076,
    });
    expect(await useCase.save(1, 6610, { ...input, movementIds: [...input.movementIds].reverse() })).toEqual(saved);
    await expect(useCase.save(1, 6610, { ...input, statementBalance: 1077 })).rejects
      .toMatchObject({ code: 'BANK_RECONCILIATION_REQUEST_CONFLICT' });
    await expect(useCase.save(1, 6610, { ...input, requestKey: crypto.randomUUID() })).rejects
      .toMatchObject({ code: 'BANK_RECONCILIATION_MOVEMENT_UNAVAILABLE' });
    const pending = { ...input, requestKey: crypto.randomUUID(), movementIds: [7300000000001], statementBalance: 1086 };
    await expect(useCase.save(1, 6610, pending)).rejects.toMatchObject({ code: 'BANK_RECONCILIATION_STALE_BALANCE' });
    await expect(useCase.save(1, 6610, { ...pending, expectedBankBalance: 1076, statementDate: '2025-01-30' })).rejects
      .toMatchObject({ code: 'BANK_RECONCILIATION_INVALID_DATE' });
    expect(await bankReconciliationState(await connect(), 1, 6610)).toEqual({ delta: 76, lastStatementDate: '2025-01-31' });
    const { rows } = await db.query('SELECT movement_id::float8 AS id FROM tuvansa.bank_reconciliation_movements ORDER BY id');
    expect(rows).toEqual([{ id: 6900000000000 }, { id: 7300000000000 }]);
  } finally {
    await db.close();
  }
}, 20_000);
