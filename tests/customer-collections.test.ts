import { PGlite } from '@electric-sql/pglite';
import { expect, it, vi } from 'vitest';
import { CaptureCustomerCollection } from '../src/modules/accounts-receivable/clients/application/use-cases/capture-customer-collection.js';
import { ReverseCustomerCollection } from '../src/modules/accounts-receivable/clients/application/use-cases/reverse-customer-collection.js';
import { PostgresCustomerCollections } from '../src/modules/accounts-receivable/clients/infrastructure/datasources/postgres-customer-collections.js';
import { PostgresCustomerCollectionReversals } from '../src/modules/accounts-receivable/clients/infrastructure/datasources/postgres-customer-collection-reversals.js';
import { salesRemissionsOutstanding } from '../src/modules/accounts-receivable/clients/infrastructure/datasources/customer-collections-reads.js';
import { bankReconciliationState } from '../src/modules/treasury/banking/infrastructure/datasources/bank-reconciliation-reads.js';
import { PostgresBankReconciliations } from '../src/modules/treasury/banking/infrastructure/datasources/postgres-bank-reconciliations.js';
import type { PostgresConnectionFactory } from '../src/shared/infrastructure/database/postgres-pool.js';

it('applies partial and final deposits to the same remission with stable retries and credit release', async () => {
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
      CREATE TABLE tuvansa.sales_remissions (
        id bigint PRIMARY KEY, number text, company_id int, customer_id bigint, issued_at date, charge numeric, result jsonb
      );
      INSERT INTO tuvansa.sales_remissions VALUES (
        7100000000000,'FAW00000001',1,15390,'2026-11-23',116,
        '{"invoice":{"movementType":"FA","canceled":false,"currency":{"id":1,"exchangeRate":1}}}'
      );
    `);
    const settings = vi.fn(async () => ({
      policyType: '1', fiscalStart: '2025-01-01', fiscalEnd: '2026-12-31',
      clientAccount: '1105001', clientAccountName: 'Clientes',
      bankAccounts: [{ id: 6610, code: '1102100001', name: 'Cuenta de prueba' }],
    }));
    const storage = new PostgresCustomerCollections(connect, () => true);
    const collections = new CaptureCustomerCollection(storage, { settings });
    const identity = { companyId: 1, clientId: 15390, remissionId: 7100000000000 };
    const first = {
      requestKey: crypto.randomUUID(), revision: 1, bankAccountId: 6610,
      amount: 40, date: '2026-11-23', description: '', reference: 'DEP-A',
    };
    const preview = await collections.prepare(identity);
    expect(preview).toMatchObject({ canWrite: true, remaining: 116, revision: 1 });
    expect((await db.query("SELECT to_regclass('tuvansa.customer_collections') AS table_name")).rows)
      .toEqual([{ table_name: null }]);
    await expect(collections.prepare({ ...identity, clientId: 99 })).rejects.toMatchObject({ statusCode: 404 });
    await expect(collections.save(identity, 0, { ...first, bankAccountId: 999 })).rejects
      .toMatchObject({ code: 'CUSTOMER_COLLECTION_BANK_UNAVAILABLE' });
    await expect(collections.save(identity, 0, { ...first, date: '2027-01-01' })).rejects
      .toMatchObject({ code: 'CUSTOMER_COLLECTION_DATE_INVALID' });

    const partial = await collections.save(identity, 0, first);
    expect(partial).toMatchObject({ number: 'PAW00000001', policyNumber: '1CW00000001', receiptNumber: 1, remaining: 76 });
    expect(await collections.save(identity, 0, first)).toEqual(partial);
    expect(await salesRemissionsOutstanding(await connect(), 1, 15390)).toBe(76);
    await expect(collections.save(identity, 0, { ...first, amount: 38 })).rejects
      .toMatchObject({ code: 'CUSTOMER_COLLECTION_REQUEST_CONFLICT' });
    await expect(collections.save(identity, 0, { ...first, requestKey: crypto.randomUUID() })).rejects
      .toMatchObject({ code: 'CUSTOMER_COLLECTION_REVISION_CHANGED' });
    const second = { ...first, requestKey: crypto.randomUUID(), revision: 2, amount: 76, reference: 'DEP-B' };
    await expect(collections.save(identity, 0, { ...second, amount: 76.01 })).rejects
      .toMatchObject({ code: 'CUSTOMER_COLLECTION_AMOUNT_EXCEEDS_BALANCE' });
    await expect(collections.save(identity, 0, { ...second, amount: 75.999 })).rejects
      .toMatchObject({ code: 'CUSTOMER_COLLECTION_AMOUNT_INVALID' });

    const final = await collections.save(identity, 0, second);
    expect(final.remaining).toBe(0);
    expect(await collections.prepare(identity)).toMatchObject({ canWrite: false, remaining: 0, revision: 3 });
    expect(await salesRemissionsOutstanding(await connect(), 1, 15390)).toBe(0);
    expect(await collections.save(identity, 0, second)).toEqual(final);
    const { rows } = await db.query('SELECT movement_type,amount::float8,reference FROM tuvansa.customer_collections ORDER BY id');
    expect(rows).toEqual([
      { movement_type: 'PA', amount: 40, reference: 'DEP-A' },
      { movement_type: 'PA', amount: 76, reference: 'DEP-B' },
    ]);

    const reversal = new ReverseCustomerCollection(new PostgresCustomerCollectionReversals(connect, () => true), {
      fiscalWindow: async () => ({ fiscalStart: '2026-01-01', fiscalEnd: '2026-12-31' }),
    });
    const finalKey = { companyId: identity.companyId, clientId: identity.clientId, collectionId: final.id };
    const rev = { requestKey: crypto.randomUUID(), date: '2026-11-24', reason: 'Depósito duplicado', confirmed: true as const };
    expect(await reversal.prepare(finalKey)).toMatchObject({ canWrite: true, amount: 76, documents: [{ id: identity.remissionId, total: 116 }] });
    expect((await db.query("SELECT to_regclass('tuvansa.customer_collection_reversals') AS table_name")).rows).toEqual([{ table_name: null }]);
    await expect(reversal.save(finalKey, 0, { ...rev, date: '2026-11-22' })).rejects.toMatchObject({ code: 'CUSTOMER_COLLECTION_REVERSAL_INVALID_DATE' });
    await expect(reversal.prepare({ ...finalKey, clientId: 9 })).rejects.toMatchObject({ statusCode: 404 });

    const reconciliation = new PostgresBankReconciliations(connect, () => true);
    const reconcile = { companyId: 1, bankAccountId: 6610, fingerprint: 'e'.repeat(64), bankOpeningBalance: async () => 1000,
      input: { requestKey: crypto.randomUUID(), movementIds: [partial.id], statementDate: '2026-11-23', statementBalance: 1040, expectedBankBalance: 1000 } };
    const originalCut = await reconciliation.commit(reconcile);
    const settledKey = { ...finalKey, collectionId: partial.id };
    expect(await reversal.prepare(settledKey)).toMatchObject({ canWrite: true,
      originalReconciliation: { id: originalCut.id, date: '2026-11-23' }, notice: expect.stringContaining('egreso pendiente') });
    await expect(reversal.save(settledKey, 0, rev)).rejects.toMatchObject({ code: 'CUSTOMER_COLLECTION_REVERSAL_RECONCILIATION_CHANGED' });

    const reversed = await reversal.save(finalKey, 0, rev);
    expect(reversed).toEqual({ id: 7980000000000, policyNumber: '1CV00000001', date: rev.date, reason: rev.reason });
    expect(await reversal.save(finalKey, 0, rev)).toEqual(reversed);
    await expect(reversal.save(finalKey, 0, { ...rev, reason: 'Otro' })).rejects.toMatchObject({ code: 'CUSTOMER_COLLECTION_REVERSAL_REQUEST_CONFLICT' });
    await expect(reconciliation.commit({ ...reconcile, input: { ...reconcile.input, requestKey: crypto.randomUUID(), movementIds: [final.id],
      statementDate: '2026-11-24', expectedBankBalance: 1040, statementBalance: 1116 } })).rejects.toMatchObject({ code: 'BANK_RECONCILIATION_MOVEMENT_UNAVAILABLE' });
    expect(await bankReconciliationState(await connect(), 1, 6610)).toEqual({ delta: 40, lastStatementDate: '2026-11-23' });
    expect(await salesRemissionsOutstanding(await connect(), 1, 15390)).toBe(76);
    expect(await collections.prepare(identity)).toMatchObject({ canWrite: true, remaining: 76, revision: 4 });
    await expect(collections.save(identity, 0, { ...second, requestKey: crypto.randomUUID(), revision: 4 }))
      .rejects.toMatchObject({ code: 'CUSTOMER_COLLECTION_DATE_INVALID' });
    const replacement = await collections.save(identity, 0, { ...second, requestKey: crypto.randomUUID(), revision: 4, date: rev.date });
    expect(replacement.remaining).toBe(0);
    const replacementCut = await reconciliation.commit({ ...reconcile, input: { ...reconcile.input,
      requestKey: crypto.randomUUID(), movementIds: [replacement.id], statementDate: '2026-11-25',
      expectedBankBalance: 1040, statementBalance: 1116 } });
    const settledCorrection = { ...rev, requestKey: crypto.randomUUID(), date: '2026-11-26', expectedReconciliationId: originalCut.id };
    expect(await reversal.prepare(settledKey)).toMatchObject({ canWrite: true, minimumDate: replacementCut.statementDate });
    await expect(reversal.save(settledKey, 0, { ...settledCorrection, expectedReconciliationId: replacementCut.id }))
      .rejects.toMatchObject({ code: 'CUSTOMER_COLLECTION_REVERSAL_RECONCILIATION_CHANGED' });
    await expect(reversal.save(settledKey, 0, { ...settledCorrection, date: '2026-11-24' }))
      .rejects.toMatchObject({ code: 'CUSTOMER_COLLECTION_REVERSAL_INVALID_DATE' });
    const booked = await reversal.save(settledKey, 0, settledCorrection);
    expect(booked.originalReconciliation).toEqual({ id: originalCut.id, date: originalCut.statementDate });
    expect(await reversal.save(settledKey, 0, settledCorrection)).toEqual(booked);
    expect(await bankReconciliationState(await connect(), 1, 6610)).toEqual({ delta: 116, lastStatementDate: replacementCut.statementDate });
    expect(await collections.prepare(identity)).toMatchObject({ canWrite: true, remaining: 40, revision: 6 });
    const third = { ...reconcile, input: { ...reconcile.input, requestKey: crypto.randomUUID(), movementIds: [booked.id],
      statementDate: '2026-11-27', expectedBankBalance: 1116, statementBalance: 1076 } };
    await expect(reconciliation.commit({ ...third, input: { ...third.input, movementIds: [reversed.id] } }))
      .rejects.toMatchObject({ code: 'BANK_RECONCILIATION_MOVEMENT_UNAVAILABLE' });
    const correctionCut = await reconciliation.commit(third);
    expect(correctionCut).toMatchObject({ netMovement: -40, bankBalance: 1076 });
    expect(await bankReconciliationState(await connect(), 1, 6610)).toEqual({ delta: 76, lastStatementDate: correctionCut.statementDate });
    expect((await db.query('SELECT movement_id::float8,reconciliation_id::float8 FROM tuvansa.bank_reconciliation_movements ORDER BY movement_id')).rows)
      .toEqual([{ movement_id: partial.id, reconciliation_id: originalCut.id },
        { movement_id: replacement.id, reconciliation_id: replacementCut.id }, { movement_id: booked.id, reconciliation_id: correctionCut.id }]);
  } finally {
    await db.close();
  }
}, 20_000);
