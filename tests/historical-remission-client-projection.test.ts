import { PGlite } from '@electric-sql/pglite';
import { afterEach, expect, it, vi } from 'vitest';
import { ClientMovement } from '../src/modules/accounts-receivable/clients/domain/entities/client-movement.js';
import {
  ClientBalanceWithSalesRemissionsDataSource, ClientMovementsWithSalesRemissionsDataSource, salesRemissionCustomerTotals,
} from '../src/modules/accounts-receivable/clients/infrastructure/datasources/client-ledger-with-sales-remissions-data-source.js';
import { salesRemissionsOutstanding } from '../src/modules/accounts-receivable/clients/infrastructure/datasources/customer-collections-reads.js';
import { LegacyMysqlClientBalanceDataSource } from '../src/modules/accounts-receivable/clients/infrastructure/datasources/legacy-mysql-client-balance-data-source.js';
import { LegacyMysqlClientMovementsDataSource } from '../src/modules/accounts-receivable/clients/infrastructure/datasources/legacy-mysql-client-movements-data-source.js';
import type { PostgresClient } from '../src/shared/infrastructure/database/postgres-pool.js';

const fixture = vi.hoisted(() => ({
  mysql: vi.fn(),
  readRemissions: vi.fn(),
  client: { id: 17, code: 'C017', name: 'Cliente de prueba', currentBalance: 175 },
  canceled: { invoiceId: 26, customerId: 17, number: 'FA0001', orderNumber: 'P001', amount: 100, userId: 3,
    issuedAt: '2025-12-01', dueAt: '2025-12-31',
    result: { id: 7960000000000, date: '2025-12-10', reason: 'Prueba', regeneratedOrder: false } },
}));

vi.mock('../src/shared/infrastructure/database/legacy-mysql-pool.js', () => ({ legacyMysqlPool: { execute: fixture.mysql } }));
vi.mock('../src/modules/accounts-receivable/clients/infrastructure/datasources/postgres-client-catalog.js', () => ({
  clientCatalogRecord: async () => null,
}));
vi.mock('../src/modules/sales/invoicing/infrastructure/datasources/postgres-sales-remissions.js', () => ({
  readSalesRemissions: fixture.readRemissions,
}));

afterEach(() => vi.resetAllMocks());

it('excludes the exact DSEQ from Saldo across the page, matched total and unfiltered summaries', async () => {
  fixture.readRemissions.mockImplementation(async (fallback: unknown) => Array.isArray(fallback) ? [fixture.canceled] : fallback);
  const summary = { totalBalance: 75, overdueBalance: 75, notDueBalance: 0,
    documentCount: 1, overdueDocumentCount: 1, notDueDocumentCount: 0 };
  fixture.mysql.mockResolvedValueOnce([[fixture.client]])
    .mockResolvedValueOnce([[summary]])
    .mockResolvedValueOnce([[{ id: 27, documentNumber: fixture.canceled.number, balance: 75, amount: 75 }]])
    .mockResolvedValueOnce([[{ total: 1 }]]);

  const balance = new ClientBalanceWithSalesRemissionsDataSource(new LegacyMysqlClientBalanceDataSource());
  const result = await balance.searchByClient({ clientId: 17, query: 'FA0001', dueStatus: 'overdue', offset: 0, limit: 1 });
  expect(result).toMatchObject({ client: { currentBalance: 75 }, summary, total: 1 });
  expect(result?.items.map((item) => item.toPrimitives().id)).toEqual([27]);
  for (const [statement] of fixture.mysql.mock.calls.slice(1)) expect(statement).toContain('d.DSEQ NOT IN (?)');
  expect(fixture.mysql.mock.calls[1]?.[1]).toEqual([17, 26]);
  expect(fixture.mysql.mock.calls[2]?.[1]).toEqual([17, 26, '%FA0001%', '%FA0001%', '%FA0001%', '%FA0001%', 1, 0]);
  expect((await salesRemissionCustomerTotals([17])).get(17)).toMatchObject({ balance: -100 });
});

it('retains the native charge and includes K in dated summaries, running balance and pagination', async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE SCHEMA tuvansa;
      CREATE TABLE tuvansa.sales_remissions (
        id bigint, result jsonb, issued_at date, order_number text, charge numeric,
        user_id integer, order_id bigint, order_revision integer, company_id integer, customer_id bigint
      );
      CREATE TABLE tuvansa.order_changes (order_id bigint, revision integer, created_at timestamptz);
      CREATE TABLE tuvansa.sales_remission_cancellations (
        id bigint, remission_id bigint, company_id integer, date date, user_id integer, result jsonb,
        legacy_invoice_id bigint, historical_source jsonb, created_at timestamptz DEFAULT now()
      );
    `);
    const { invoiceId, result: cancellation, userId, ...historicalSource } = fixture.canceled;
    await db.query(`INSERT INTO tuvansa.sales_remission_cancellations
      (id,company_id,date,user_id,result,legacy_invoice_id,historical_source) VALUES ($1,1,$2,$3,$4::jsonb,$5,$6::jsonb)`,
      [cancellation.id, cancellation.date, userId, cancellation, invoiceId, historicalSource]);
    const connection: PostgresClient = {
      query<T extends object>(statement: string, values?: unknown[]) { return db.query<T>(statement, values); },
      release() {},
    };
    fixture.readRemissions.mockImplementation(async (_fallback: unknown, read: (client: PostgresClient) => Promise<unknown>) => read(connection));
    const original = ClientMovement.create({
      id: 112, date: fixture.canceled.issuedAt, movementType: { code: 'F', description: 'Remision' },
      amount: 100, runningBalance: 100, paymentReference: '', policy: '', receiptNumber: 0, userId: 1, exchangeRate: 1,
      document: { id: 26, number: 'FA0001', date: '2025-12-01', dueDate: '2025-12-31', reference: 'P001',
        amount: 100, currencyId: 1, isCanceled: false },
    });
    const legacy = new LegacyMysqlClientMovementsDataSource();
    vi.spyOn(legacy, 'balanceThroughDates').mockResolvedValue(new Map([['2025-12-10', 100]]));
    vi.spyOn(legacy, 'searchByClient').mockImplementation(async ({ dateFrom, offset, limit }) => {
      const charge = !dateFrom || dateFrom <= original.toPrimitives().date ? 100 : 0;
      const openingBalance = charge ? 0 : 100;
      return { client: fixture.client, items: charge ? [original].slice(offset, offset + limit) : [],
        summary: { openingBalance, charges: charge, credits: 0, netMovement: charge,
          closingBalance: openingBalance + charge, movementCount: charge ? 1 : 0 } };
    });
    const source = new ClientMovementsWithSalesRemissionsDataSource(legacy);
    const criteria = { clientId: 17, offset: 0, limit: 2 };
    const result = await source.searchByClient(criteria);
    expect(result).toMatchObject({ client: { currentBalance: 75 },
      summary: { openingBalance: 0, charges: 100, credits: 100, netMovement: 0, closingBalance: 0, movementCount: 2 } });
    expect(result?.items[0]?.toPrimitives()).toEqual(original.toPrimitives());
    const reversal = result?.items[1]?.toPrimitives();
    expect(reversal).toMatchObject({ id: fixture.canceled.result.id, movementType: { code: 'K' },
      runningBalance: 0, amount: -100, credit: 100,
      document: { id: 26, number: 'FA0001', date: '2025-12-01', dueDate: '2025-12-31', isCanceled: true } });
    const laterPage = await source.searchByClient({ ...criteria, offset: 1, limit: 1 });
    expect(laterPage?.items.map((item) => item.toPrimitives())).toEqual([reversal]);
    const before = await source.searchByClient({ ...criteria, dateTo: '2025-12-09' });
    expect(before?.summary).toMatchObject({ closingBalance: 100, credits: 0, movementCount: 1 });
    const after = await source.searchByClient({ ...criteria, dateFrom: '2025-12-11' });
    expect(after?.summary).toMatchObject({ openingBalance: 0, closingBalance: 0, credits: 0, movementCount: 0 });

    await db.exec('INSERT INTO tuvansa.sales_remissions (id,customer_id,company_id,charge) VALUES (42,17,1,40)');
    expect(await salesRemissionsOutstanding(connection, 1, 17)).toBe(-60);
    expect(await salesRemissionsOutstanding(connection, 2, 17)).toBe(0);
    expect(await salesRemissionsOutstanding(connection, 1, 18)).toBe(0);
  } finally { await db.close(); }
}, 15000);
