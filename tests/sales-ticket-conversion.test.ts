import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import request from 'supertest';
import { expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import type { env } from '../src/config/env.js';
import { ConvertSalesTicket } from '../src/modules/sales/invoicing/application/use-cases/convert-sales-ticket.js';
import type { SalesTicketConversionSource } from '../src/modules/sales/invoicing/domain/datasources/sales-ticket-conversion-data-source.js';
import { postInvoiceFromOrder } from '../src/modules/sales/invoicing/domain/entities/invoice-from-order.js';
import { PostgresSalesRemissions } from '../src/modules/sales/invoicing/infrastructure/datasources/postgres-sales-remissions.js';
import type { OrderProps } from '../src/modules/sales/orders/domain/entities/order.js';
import { PostgresOrderOverlayDataSource } from '../src/modules/sales/orders/infrastructure/datasources/postgres-order-overlay-data-source.js';
import type { PostgresConnectionFactory } from '../src/shared/infrastructure/database/postgres-pool.js';

const runtime = vi.hoisted(() => ({
  connect: vi.fn<PostgresConnectionFactory>(), enabled: true,
}));

vi.mock('../src/config/env.js', async (importOriginal) => {
  const { env: actualEnv } = await importOriginal<{ env: typeof env }>();
  return { env: { ...actualEnv, API_PREFIX: '/api', NEON_DATABASE_URL: 'postgres://test.invalid/pglite' } };
});

vi.mock('../src/shared/infrastructure/database/postgres-pool.js', async (importOriginal) => ({
  ...await importOriginal<object>(), connectPostgres: runtime.connect, postgresConfigured: () => true,
}));

vi.mock('../src/shared/infrastructure/database/legacy-mysql-pool.js', () => ({
  legacyMysqlPool: { execute: async (sql: string) => {
    if (!sql.includes('JOIN FTIPMV fe') || !sql.startsWith('SELECT')) throw new Error('Unexpected legacy query');
    return [runtime.enabled ? [{ enabled: 1 }] : [], []];
  } },
}));

const originalDate = '2025-11-20';
const currentDate = () => new Intl.DateTimeFormat('sv-SE', { dateStyle: 'short', timeZone: 'America/Mexico_City' }).format();
const root = '/api/sales/invoices';
const previewPath = (id: number) => `${root}/${id}/summaries/ticket-to-invoice`;

async function postFirstRemission(connect: PostgresConnectionFactory) {
  const orders = new PostgresOrderOverlayDataSource(connect, () => true);
  const sales = new PostgresSalesRemissions(orders, connect, { layers: async () => [] });
  const order = await orders.create(async (id): Promise<OrderProps> => ({
    id, number: 'PW9001', customerOrderNumber: '', documentKind: 'order', status: '', fulfilledAmount: 0,
    customer: { id: 100, code: 'C001', name: 'Cliente de pruebas' }, branch: 0, department: '',
    dates: { orderedAt: originalDate, from: null, dueAt: null }, attention: '', termsDays: 30, authorization: 'O.K.',
    initial: false, warehouse: '01', currencyId: 0, exchangeRate: 1, minimumFulfillmentPercentage: 0, observations: '',
    classifications: [], captureDetails: { boxes: 0, collectionCurrency: 'PESOS', commission: 0, noPartialDeliveries: false,
      transportation: '', deliveryAddress: ['', '', ''], contact: '', additionalComments: '' },
    totals: { quantity: 4, ordered: 4, fulfilled: 0, remaining: 4, subtotal: 200, discount: 0,
      freight: 0, insurance: 0, other: 0, tax: 32, total: 232 },
    lines: [{ id: 101, productId: 7, productCode: 'A', description: 'Producto A', ordered: 4,
      fulfilled: 0, remaining: 4, unit: 'PZ', assigned: 4, branch: 0, price: 50, classCode: '', currencyId: 0,
      piecesAssignment: '', discount: 0, publicPrice: 50, sku: '', color: '', size: '' }],
  }));
  const requestKey = randomUUID();
  const input = { orderNumber: order.number, requestKey, revision: 1, issuedAt: originalDate, lines: [{ orderLineId: 101, quantity: 2 }] };
  const { invoice } = await sales.commit({
    companyId: 1, userId: 1, requestKey, orderId: order.id, orderNumber: order.number, revision: 1, fingerprint: 'a'.repeat(64),
    post: async (current, balance) => postInvoiceFromOrder(current, {
      fiscalStart: '2025-01-01', fiscalEnd: '2025-12-31', reason: null, vat: 16, customerTermsDays: 30, creditLimit: 1000,
      creditBalance: 0, products: new Map([[7, { id: 7, code: 'A', unit: 'PZ', package: '', family: '', cost: 25,
        legacyOnHand: 20, legacyAssigned: 0, supported: true }]]),
    }, input, 1, 1, balance ?? 0),
  });
  return { invoice, order };
}

it('convierte una FAW en Facturación y conserva la remisión, el surtido y el cargo de origen', async () => {
  const db = new PGlite();
  let failCommit = false;
  const connect: PostgresConnectionFactory = async () => ({
    async query<T extends object>(sql: string, values?: unknown[]) {
      if (sql === 'COMMIT' && failCommit) { failCommit = false; throw new Error('Injected interruption after writing the conversion'); }
      if (values) return db.query<T>(sql, values);
      const results = await db.exec(sql);
      return { rows: (results.at(-1)?.rows ?? []) as T[] };
    },
    release() {},
  });
  runtime.connect.mockImplementation(connect);
  runtime.enabled = true;
  try {
    const { invoice, order } = await postFirstRemission(connect);
    const api = request(createApp());
    const path = previewPath(invoice.id);
    const raw = async () => (await Promise.all([
      db.query('SELECT result,movement,line_effects,number,issued_at::text,charge::float8 FROM tuvansa.sales_remissions WHERE id=$1', [invoice.id]),
      db.query('SELECT revision,document FROM tuvansa.orders WHERE id=$1', [order.id]),
      db.query('SELECT product_id,warehouse,quantity::float8 FROM tuvansa.sales_remission_inventory WHERE remittance_id=$1', [invoice.id]),
    ])).map(({ rows }) => rows);
    const origin = await raw();
    const conversionCount = async () => (await db.query<{ total: number }>('SELECT count(*)::int AS total FROM tuvansa.sales_ticket_conversions')).rows[0]?.total;

    await api.get(previewPath(invoice.id + 1)).expect(404);
    runtime.enabled = false;
    const blocked = await api.get(path).expect(200).expect('Cache-Control', 'no-store');
    expect(blocked.body.data).toMatchObject({ readOnly: true, ticketConversion: { version: null, result: null } });
    expect(blocked.body.data.reason).toMatch(/configuración de México/);
    expect((await db.query("SELECT to_regclass('tuvansa.sales_ticket_conversions') AS table_name")).rows)
      .toEqual([{ table_name: null }]);
    runtime.enabled = true;

    const preview = await api.get(path).expect(200);
    expect(preview.body.data).toMatchObject({ readOnly: false, ticketConversion: {
      sourceNumber: invoice.number, targetType: 'FE', total: 116, balance: 116, currency: 'PESOS', result: null,
    } });
    const input = { expectedVersion: preview.body.data.ticketConversion.version, requestKey: randomUUID() };
    await api.post(path).send({ ...input, number: 'FE0001234' }).expect(400);
    await api.post(previewPath(346421)).send(input).expect(422);

    const stale = await api.post(path).send({ ...input, expectedVersion: 'f'.repeat(64) }).expect(409);
    expect(stale.body.error.code).toBe('SALES_TICKET_CONVERSION_STALE');
    expect(await conversionCount()).toBe(0);
    expect(await raw()).toEqual(origin);

    runtime.enabled = false;
    const invalidSetup = await api.post(path).send(input).expect(422);
    expect(invalidSetup.body.error.code).toBe('SALES_TICKET_CONVERSION_CONFIGURATION');
    expect(await conversionCount()).toBe(0);
    runtime.enabled = true;
    failCommit = true;
    await api.post(path).send(input).expect(503);
    expect(await conversionCount()).toBe(0);
    expect(await raw()).toEqual(origin);

    const first = await api.post(path).send(input).expect(201).expect('Cache-Control', 'no-store');
    const result = first.body.data;
    expect(result).toMatchObject({ invoiceId: invoice.id, sourceNumber: invoice.number, issuedAt: currentDate(), number: expect.stringMatching(/^FEW\d{8}$/) });
    expect((await api.post(path).send(input).expect(201)).body.data).toEqual(result);
    const reuse = await api.post(path).send({ ...input, expectedVersion: 'f'.repeat(64) }).expect(409);
    expect(reuse.body.error.code).toBe('SALES_TICKET_CONVERSION_REQUEST_REUSED');
    const second = await api.post(path).send({ ...input, requestKey: randomUUID() }).expect(409);
    expect(second.body.error.code).toBe('SALES_TICKET_ALREADY_CONVERTED');
    expect(await conversionCount()).toBe(1);
    expect(await raw()).toEqual(origin);

    const converted = (await api.get(`${root}/${invoice.id}`).expect(200)).body.data;
    expect(converted).toMatchObject({ id: invoice.id, number: result.number, orderNumber: order.number, movementType: 'FA', cfdStatus: '1',
      deliveryNote: invoice.number, folio: '', cancellationAvailable: false,
      dates: { issuedAt: result.issuedAt, deliveryNoteAt: originalDate, dueAt: invoice.dates.dueAt },
      totals: { total: 116, balance: 116, paid: 0 }, lines: invoice.lines,
    });
    for (const folio of [invoice.number, result.number]) {
      expect((await api.get(`${root}/by-number/${folio}`).expect(200)).body.data).toEqual(converted);
    }
    const after = (await api.get(path).expect(200)).body.data;
    expect(after).toMatchObject({ readOnly: true, ticketConversion: { result, version: null, total: 116, balance: 116 } });
    const auxiliary = (await api.get(`${root}/${invoice.id}/actions/auxiliary`).expect(200)).body.data;
    expect(auxiliary).toMatchObject({ summary: { charges: 116, credits: 0, balance: 116 }, items: [{ date: result.issuedAt, amount: 116 }] });

    const previewSource: SalesTicketConversionSource = { invoice, charge: 116, paid: 0, paymentRevision: 1, canceled: false, result: null };
    const source = vi.fn<() => Promise<SalesTicketConversionSource | null>>();
    const command = new ConvertSalesTicket({ source, convert: vi.fn() }, async () => true);
    for (const [state, reason] of [
      [{ ...previewSource, canceled: true }, /cancelada/],
      [{ ...previewSource, invoice: { ...invoice, cfdStatus: '3' } }, /estado fiscal/],
      [{ ...previewSource, paymentRevision: 2 }, /movimientos de cobranza/],
      [{ ...previewSource, invoice: { ...invoice, currency: { id: 2, name: 'USD', exchangeRate: 20 } } }, /en pesos/],
      [{ ...previewSource, invoice: { ...invoice, lines: [] } }, /partidas positivas/],
    ] as const) {
      source.mockResolvedValueOnce(state);
      expect(await command.preview(invoice.id)).toMatchObject({ reason: expect.stringMatching(reason), preview: { version: null } });
    }
  } finally {
    runtime.connect.mockReset();
    runtime.enabled = true;
    await db.close();
  }
}, 25_000);
