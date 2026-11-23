import { PGlite } from '@electric-sql/pglite';
import { expect, it } from 'vitest';
import { CaptureBankTransfer } from '../src/modules/treasury/banking/application/use-cases/capture-bank-transfer.js';
import { bankCatalogDefaults, projectBankCatalog } from '../src/modules/treasury/banking/domain/entities/bank-catalog.js';
import { PostgresBankTransfers } from '../src/modules/treasury/banking/infrastructure/datasources/postgres-bank-transfers.js';
import type { PostgresConnectionFactory } from '../src/shared/infrastructure/database/postgres-pool.js';

it('registers the first transfer to a new account with both bank movements and a single request key', async () => {
  const db = new PGlite();
  const connect: PostgresConnectionFactory = async () => ({
    async query<T extends object>(sql: string, values?: unknown[]) {
      if (values) return db.query<T>(sql, values);
      const results = await db.exec(sql);
      return { rows: (results.at(-1)?.rows ?? []) as T[] };
    },
    release() {},
  });

  try {
    const account = (id: number, code: string) => {
      const defaults = bankCatalogDefaults();
      return projectBankCatalog(null, {
        id, legacy: false, revision: 1, createdOn: '2026-01-01',
        fields: {
          ...defaults, code, name: code, systemType: 'bank', currencyId: 1,
          control: { ...defaults.control, payments: true, deposits: true },
        },
      }, false)!.toPrimitives();
    };

    const source = account(7800000000000, '1102100001');
    const destination = account(7800000000001, '1102100002');
    const accounts = new Map([[source.id, source], [destination.id, destination]]);
    const storage = new PostgresBankTransfers(connect, () => true, {
      lookupOn: () => async (id) => accounts.get(id) ?? null,
    });
    const transfer = new CaptureBankTransfer(storage, {
      settings: async () => ({ policyType: '3', fiscalStart: '2026-01-01', fiscalEnd: '2026-12-31' }),
      account: async () => { throw new Error('La escritura debe reutilizar la conexión del registro.'); },
      sources: async () => [source],
    });
    const input = {
      requestKey: 'cc47f080-9679-4d54-84c7-86aa46127ab8',
      sourceBankAccountId: source.id, date: '2026-02-01', amount: 25.12, reference: 'PRUEBA01',
      beneficiary: 'Tesorería', description: 'Primer traspaso',
    };

    expect(destination.control.movements).toBe(false);
    const result = await transfer.save(1, 0, destination.id, input);
    expect(await transfer.save(1, 0, destination.id, input)).toEqual(result);
    await expect(transfer.save(1, 0, destination.id, { ...input, amount: 50 })).rejects.toMatchObject({
      code: 'BANK_TRANSFER_REQUEST_CONFLICT',
    });

    const { rows } = await db.query(
      'SELECT bank_account_id::float8 AS id, amount::float8 AS amount FROM tuvansa.bank_transfer_movements ORDER BY id',
    );
    expect(rows).toEqual([{ id: source.id, amount: -25.12 }, { id: destination.id, amount: 25.12 }]);

    destination.control.preventJournalEntries = true;
    await expect(transfer.save(1, 0, destination.id, { ...input, requestKey: 'd59e118a-f04d-4c6d-9c36-f1a36a6c37fa' })).rejects
      .toMatchObject({ code: 'BANK_TRANSFER_DESTINATION_UNAVAILABLE' });
  } finally {
    await db.close();
  }
});
