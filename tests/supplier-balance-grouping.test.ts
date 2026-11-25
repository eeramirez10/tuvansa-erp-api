import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import request from 'supertest';
import { afterAll, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import type { env } from '../src/config/env.js';
import { PostgresPurchaseReceptionCancellations } from '../src/modules/purchasing/purchase-receptions/infrastructure/datasources/postgres-purchase-reception-cancellations.js';
import type { ReceiptCancellationSource } from '../src/modules/purchasing/purchase-receptions/domain/datasources/purchase-reception-cancellation-data-source.js';
import type { PostgresConnectionFactory } from '../src/shared/infrastructure/database/postgres-pool.js';

const db = new PGlite();
let next = Promise.resolve();
let failOnTransfer = 0;
const connect: PostgresConnectionFactory = async () => {
  // Each concurrent HTTP request checks out its own logical transaction on PGlite's single connection.
  const previous = next;
  let release!: () => void;
  next = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  return {
    async query<T extends object>(sql: string, values?: unknown[]) {
      if (sql.includes('INSERT INTO tuvansa.supplier_balance_grouping_transfers') && failOnTransfer > 0 && --failOnTransfer === 0) {
        throw new Error('Interrupt the second transfer');
      }
      if (values) return db.query<T>(sql, values);
      const result = await db.exec(sql);
      return { rows: (result.at(-1)?.rows ?? []) as T[] };
    },
    release,
  };
};

vi.mock('../src/config/env.js', async (importOriginal) => {
  const { env: actualEnv } = await importOriginal<{ env: typeof env }>();
  return { env: { ...actualEnv, API_PREFIX: '/api', NEON_DATABASE_URL: 'postgres://test.invalid/pglite' } };
});
vi.mock('../src/shared/infrastructure/database/postgres-pool.js', async (importOriginal) => ({
  ...await importOriginal<object>(), connectPostgres: () => connect(), postgresConfigured: () => true,
}));

function document(id: number, amount: number, originalAmount = amount, currency = 1) {
  return {
    id, company: 1, document: `RA${id}`, date: '2025-02-05', currency,
    exchangeRate: 1, activeSupplier: 1, groupingStatus: '', amount, originalAmount,
  };
}

const historical = new Map([
  [11, [document(8001, 1013.03), document(8002, 44225.65, 81784.07), document(8003, 125, 125, 2)]],
  [12, [document(9001, 10), document(9002, 20), document(9003, 30)]],
]);

vi.mock('../src/shared/infrastructure/database/legacy-mysql-pool.js', () => ({
  legacyMysqlPool: { execute: async (sql: string, [supplierId, ...ids]: number[]) => {
    if (!sql.trimStart().startsWith('SELECT')) throw new Error('Historical SQL must stay read-only');
    const documents = historical.get(supplierId) ?? [];
    if (sql.includes('FROM FDOC JOIN FPRV')) return [documents.filter(({ id }) => !ids.length || ids.includes(id))];
    if (sql.includes('AS paidAt')) return [documents.map(({ id, document }) => ({ id, document, paidAt: '1900-12-31' }))];
    if (sql.includes('FDOC.DNUM AS number FROM FDOC')) {
      const row = [...historical.values()].flat().find(({ id }) => id === supplierId);
      return [row ? [{ id: row.id, number: row.document }] : []];
    }
    if (sql.includes('LEFT JOIN FDOC AS RELATED')) {
      const row = [...historical.values()].flat().find(({ id }) => id === supplierId);
      return [row ? [{ id: row.id + 10000, transactionType: 'RA', signedAmount: row.amount }] : []];
    }
    if (sql.includes('FROM FAX LEFT JOIN FPRV')) return [[{
      id: 77, receiptId: 8002, amount: -37558.42, movementType: 'PP', document: 'RA8002', paymentReference: 'Cheque antiguo',
    }].filter(() => supplierId === 11)];
    if (sql.includes('FROM FPRV WHERE PRVSEQ')) {
      return [documents.length ? [{
        id: supplierId, code: 'TEST', name: 'Proveedor de prueba', currentBalance: supplierId === 11 ? 45363.68 : 60,
      }] : []];
    }
    throw new Error(`Unrecognized read ${sql}`);
  } },
}));

const route = (id: number) => `/api/accounts-payable/suppliers/${id}`;

function positions(items: { id: number; groupingRevision: string }[]) {
  return items.map(({ id, groupingRevision }) => ({ id, revision: groupingRevision }));
}

afterAll(async () => { await db.close(); });

it('groups a partially paid source once with equal AT legs, updates Saldo and rejects obsolete writes', async () => {
  const api = request(createApp());
  const balance = route(11) + '/balance';
  const [target, source, otherCurrency] = positions((await api.get(balance).expect(200)).body.data.items);
  expect(otherCurrency?.revision).toBeUndefined();
  const body = { target, sources: [source], requestKey: randomUUID() };
  await api.post(balance + '/grouping').send({ ...body, sources: [target] }).expect(409);
  await api.post(balance + '/grouping').send({
    ...body, sources: [{ id: 9002, revision: source!.revision }],
  }).expect(409);
  await api.post(balance + '/grouping').send({
    ...body, sources: [{ id: otherCurrency!.id, revision: source!.revision }],
  }).expect(409);

  const competing = { ...body, requestKey: randomUUID() };
  const results = await Promise.all([api.post(balance + '/grouping').send(body), api.post(balance + '/grouping').send(competing)]);
  expect(results.map(({ status }) => status).sort()).toEqual([201, 409]);
  const firstWon = results[0]!.status === 201;
  const posted = results[firstWon ? 0 : 1]!.body.data;
  const accepted = firstWon ? body : competing;
  expect(posted).toMatchObject({ targetId: 8001, sourceIds: [8002], amount: 44225.65, remaining: 45238.68 });
  await api.post(balance + '/grouping').send(accepted).expect(201, { data: posted });
  const reused = await api.post(balance + '/grouping').send({ ...accepted, target: source, sources: [target] }).expect(409);
  expect(reused.body.error.code).toBe('SUPPLIER_GROUPING_REQUEST_CONFLICT');

  const after = await api.get(balance).expect(200);
  expect(after.body.data).toMatchObject({
    supplier: { currentBalance: 45363.68 },
    items: [{ id: 8001, amount: 45238.68, originalAmount: 1013.03 }, { id: 8003, amount: 125 }],
    summary: { amount: 45363.68, originalAmount: 1138.03 },
  });
  expect(after.body.data.items[0].groupingRevision).not.toBe(target!.revision);
  const movements = await api.get(route(11) + '/movements').expect(200);
  expect(movements.body.data.items).toMatchObject([
    { document: 'RA8002', movementType: 'PP', amount: -37558.42 },
    { document: 'RA8001', relatedDocumentId: 8002, movementType: 'AT', amount: 44225.65, paymentReference: 'RA8002', policy: '' },
    { document: 'RA8002', relatedDocumentId: 8001, movementType: 'AT', amount: -44225.65, paymentReference: 'RA8001', policy: '' },
  ]);
  const invoices = await api.get(route(11) + '/invoices').expect(200);
  expect(invoices.body.data.items.find(({ id }: { id: number }) => id === 8002)).toMatchObject({ paidAt: posted.date });
  const auxiliary = await api.get('/api/purchasing/purchase-receptions/8002/actions/auxiliary').expect(200);
  expect(auxiliary.body.data).toMatchObject({
    summary: { total: 0 },
    items: [{ transactionType: 'RA' },
      { transactionType: 'AT', relatedDocumentId: 8001, relatedDocument: 'RA8001', signedAmount: -44225.65 }],
  });

  const payment = route(11) + '/payments/8002';
  await api.get(payment).expect(404);
  await api.post(payment).send({
    requestKey: randomUUID(), revision: 1, bankAccountId: 1, mode: 'transfer',
    amount: 1, date: '2025-02-05', description: '',
  }).expect(404);
  const cancellations = new PostgresPurchaseReceptionCancellations({ postReceipt: vi.fn() }, connect, () => true, {
    read: async (id) => ({ id, historical: { version: 'historical', blockedReason: null } }) as ReceiptCancellationSource,
    inventory: async () => new Map(),
  });
  for (const id of [8001, 8002]) {
    expect(await cancellations.source(1, id)).toMatchObject({
      historical: { blockedReason: 'El saldo de la recepción cambió por una agrupación de documentos.' },
    });
  }
  for (const item of historical.get(11)!) item.activeSupplier = 0;
  const deactivated = await api.get(balance).expect(200);
  expect(deactivated.body.data.items.map(({ id, amount, groupingRevision }: { id: number; amount: number; groupingRevision?: string }) =>
    [id, amount, groupingRevision])).toEqual([[8001, 45238.68, undefined], [8003, 125, undefined]]);
});

it('rolls back every leg and the request key if a later transfer fails', async () => {
  const api = request(createApp());
  const balance = route(12) + '/balance';
  const [target, first, second] = positions((await api.get(balance).expect(200)).body.data.items);
  const body = { target, sources: [second, first], requestKey: randomUUID() };
  failOnTransfer = 2;
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  try { await api.post(balance + '/grouping').send(body).expect(500); }
  finally { consoleError.mockRestore(); }
  expect((await api.get(balance).expect(200)).body.data.items.map(({ amount }: { amount: number }) => amount)).toEqual([10, 20, 30]);
  expect((await api.get(route(12) + '/movements').expect(200)).body.data.items).toEqual([]);
  const retry = await api.post(balance + '/grouping').send(body).expect(201);
  expect(retry.body.data).toMatchObject({ sourceIds: [9002, 9003], amount: 50, remaining: 60 });
  await api.post(balance + '/grouping').send({ ...body, sources: [first, second] }).expect(201, retry.body);
  expect((await api.get(route(12) + '/movements').expect(200)).body.data.items).toHaveLength(4);
});
