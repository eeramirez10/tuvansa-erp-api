import { PGlite } from '@electric-sql/pglite';
import { expect, it, vi } from 'vitest';
import { CaptureCustomerCollection } from '../src/modules/accounts-receivable/clients/application/use-cases/capture-customer-collection.js';
import { PostgresCustomerCollections } from '../src/modules/accounts-receivable/clients/infrastructure/datasources/postgres-customer-collections.js';
import { salesRemissionsOutstanding } from '../src/modules/accounts-receivable/clients/infrastructure/datasources/customer-collections-reads.js';
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
  } finally {
    await db.close();
  }
}, 20_000);
