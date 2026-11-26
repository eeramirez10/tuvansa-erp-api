import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import express from 'express';
import request from 'supertest';
import { expect, it } from 'vitest';
import { env } from '../src/config/env.js';
import { salesRemissionsOutstanding } from '../src/modules/accounts-receivable/clients/infrastructure/datasources/customer-collections-reads.js';
import { cookieName } from '../src/modules/general-data/users/presentation/web-session-http.js';
import type { MovementDocument } from '../src/modules/inventories/movements/domain/entities/inventory-movement.js';
import { PostgresInventoryAdjustmentsDataSource } from '../src/modules/inventories/movements/infrastructure/datasources/postgres-inventory-adjustments.js';
import type { SalesRemissionCancellationSource } from '../src/modules/sales/invoicing/domain/datasources/sales-remission-cancellation-data-source.js';
import { invoiceTransfersOn } from '../src/modules/sales/invoicing/infrastructure/datasources/invoice-transfer-reads.js';
import { PostgresInvoiceTransfers } from '../src/modules/sales/invoicing/infrastructure/datasources/postgres-invoice-transfers.js';
import { createInvoiceTransferRouter } from '../src/modules/sales/invoicing/presentation/http/invoice-transfer-routes.js';
import { ApplicationError } from '../src/shared/domain/errors/application-error.js';
import type { PostgresConnectionFactory } from '../src/shared/infrastructure/database/postgres-pool.js';
import { errorHandler } from '../src/shared/infrastructure/http/error-handler.js';
import { postgresWriteBoundary } from '../src/shared/infrastructure/http/postgres-write-boundary.js';

const fixture = {
  id: 346529, number: 'FA25676', issuedAt: '2025-02-24', customerId: 60, orderNumber: '', warehouse: '01', charge: 1624,
  historical: { version: 'original', blockedReason: null },
  invoice: {
    dates: { dueAt: '2025-03-26' }, totals: { subtotal: 1400, tax: 224, total: 1624 },
    lines: [{ price: 1400, fulfilledQuantity: 1 }],
  },
  movement: {
    header: { id: 346529, document: 'FA25676', warehouse: '01', date: '2025-02-24', type: 'FA', inventoryFlag: 1 },
    lines: [{ productId: 2553, productCode: '01201605', description: 'BRIDA', quantity: -1, cost: 1387.1776, unit: 'PZ', lotId: 0 }],
  },
} as SalesRemissionCancellationSource;

it('posts one TA entry and its customer credit together and blocks duplicate and stale confirmations', async () => {
  const db = new PGlite();
  let available = Promise.resolve();
  let failCredit = false;
  const connect: PostgresConnectionFactory = async () => {
    const ready = available;
    let release!: () => void;
    available = new Promise<void>(resolve => { release = resolve; });
    await ready;
    return {
      async query<T extends object>(sql: string, values?: unknown[]) {
        if (failCredit && sql.includes('INSERT INTO tuvansa.invoice_transfers')) throw new Error('Test credit failure');
        if (values) return db.query<T>(sql, values);
        return { rows: ((await db.exec(sql)).at(-1)?.rows ?? []) as T[] };
      },
      release,
    };
  };
  let enabled = false;
  let source = fixture;
  const date = '2026-11-26';
  const action = new PostgresInvoiceTransfers(
    { read: async id => id === source.id ? source : null },
    async () => ({ enabled, warehouses: [{ code: '01', name: 'México' }, { code: '11', name: 'No calidad' }] }),
    connect, () => true, () => date,
  );
  const token = 'a'.repeat(43);
  const actor = { id: 'test-web-user', legacyId: 3, captureFrom: null, captureUntil: null };
  const app = express().use(express.json()).use('/api', postgresWriteBoundary)
    .use('/api/sales/invoices', createInvoiceTransferRouter(action, async candidate => {
      if (candidate !== token) throw new ApplicationError('Permiso de prueba', 'INVOICE_TRANSFER_FORBIDDEN', candidate ? 403 : 401);
      return actor;
    })).use(errorHandler);
  const path = `/api/sales/invoices/${fixture.id}/summaries/transfer`;
  const signedIn = `${cookieName}=${token}`;
  const preview = (warehouse = '11') => request(app).get(`${path}/preview`).query({ warehouse }).set('Cookie', signedIn);
  const confirm = (input: object, cookie = signedIn) => request(app).post(path).set('Cookie', cookie)
    .set('Host', 'localhost:5173').set('Origin', 'http://localhost:5173').send(input);
  const previousUrl = env.NEON_DATABASE_URL;
  const previousOrigin = env.WEB_SESSION_ORIGIN;
  env.NEON_DATABASE_URL = 'postgres://fixture@127.0.0.1:1/never-connect';
  env.WEB_SESSION_ORIGIN = 'http://localhost:5173';
  try {
    await request(app).get(`${path}/preview`).expect(401);
    await request(app).get(`${path}/preview`).set('Cookie', `${cookieName}=${'b'.repeat(43)}`).expect(403);
    expect((await preview().expect(200)).body.data).toMatchObject({ revision: null, reason: expect.stringContaining('tipo TA') });
    enabled = true;
    expect((await preview('01').expect(200)).body.data).toMatchObject({ revision: null, to: null });
    const reviewed = (await preview().expect(200)).body.data;
    expect(reviewed).toMatchObject({ from: '01', to: '11', amount: 1624, date, reason: null,
      lines: [{ productCode: '01201605', quantity: 1, cost: 1387.1776, price: 1400 }] });
    const payload = { warehouse: '11', revision: reviewed.revision, requestKey: randomUUID(), confirmed: true };
    await confirm(payload, `${cookieName}=${'b'.repeat(43)}`).expect(403);
    await confirm(payload).set('Origin', 'http://other.example').expect(403);
    source = { ...fixture, historical: { version: 'changed', blockedReason: null } };
    await confirm(payload).expect(409);
    source = fixture;
    failCredit = true;
    await confirm(payload).expect(503);
    const counts = `SELECT (SELECT count(*)::int FROM tuvansa.invoice_transfers) AS credits,
      (SELECT count(*)::int FROM tuvansa.inventory_adjustments) AS documents,
      (SELECT count(*)::int FROM tuvansa.inventory_adjustment_stock) AS stock`;
    expect((await db.query(counts)).rows).toEqual([{ credits: 0, documents: 0, stock: 0 }]);
    failCredit = false;
    const replies = await Promise.all([confirm(payload), confirm(payload)]);
    expect(replies.map(reply => reply.status)).toEqual([201, 201]);
    const receipt = replies[0]!.body.data;
    expect(replies[1]!.body.data).toEqual(receipt);
    expect(receipt).toMatchObject({ number: expect.stringMatching(/^TAW\d{8}$/), amount: 1624, date, from: '01', to: '11' });
    await confirm({ ...payload, requestKey: randomUUID() }).expect(409);
    await confirm({ ...payload, revision: 'b'.repeat(64) }).expect(409);
    expect((await db.query(counts)).rows).toEqual([{ credits: 1, documents: 1, stock: 1 }]);
    const { rows } = await db.query<{ movement: MovementDocument }>(
      'SELECT movement FROM tuvansa.inventory_adjustments',
    );
    const movement = rows[0]!.movement;
    expect(movement).toMatchObject({
      header: { warehouse: '11', document: receipt.number, type: 'TA', reference: fixture.number },
      lines: [{ warehouse: '11', quantity: 1, invoicedQuantity: -1, cost: 1387.1776, price: 1400 }],
      invoiceTransfer: { sourceId: fixture.id, subtotal: 1400, tax: 224, total: 1624 },
    });
    expect((await db.query('SELECT warehouse,quantity::float8 FROM tuvansa.inventory_adjustment_stock')).rows)
      .toEqual([{ warehouse: '11', quantity: 1 }]);
    expect(await new PostgresInventoryAdjustmentsDataSource().canCancel(movement)).toContain('vinculada');
    const client = await connect();
    try {
      expect(await invoiceTransfersOn(client, { customerIds: [fixture.customerId] })).toMatchObject([{ result: receipt }]);
      expect(await salesRemissionsOutstanding(client, 1, fixture.customerId)).toBe(-1624);
      expect(await salesRemissionsOutstanding(client, 2, fixture.customerId)).toBe(0);
    } finally { client.release(); }
    expect((await preview().expect(200)).body.data).toMatchObject({ receipt, revision: null });
  } finally {
    env.NEON_DATABASE_URL = previousUrl;
    env.WEB_SESSION_ORIGIN = previousOrigin;
    await db.close();
  }
}, 15000);
