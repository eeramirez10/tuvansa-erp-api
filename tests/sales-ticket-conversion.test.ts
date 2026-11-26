import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import request from 'supertest';
import { expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import type { env } from '../src/config/env.js';
import { webAccess } from '../src/modules/general-data/users/users-module.js';
import { ConvertSalesTicket } from '../src/modules/sales/invoicing/application/use-cases/convert-sales-ticket.js';
import { CreateInvoiceFromOrder } from '../src/modules/sales/invoicing/application/use-cases/create-invoice-from-order.js';
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
    if (sql.startsWith('SELECT') && sql.includes('FROM FPENC')) return [[], []];
    if (sql.includes('AS onHand') && sql.includes('FROM FINV I LEFT JOIN FALM')) {
      return [[{ productId: 7, unit: 'PZ', onHand: 20, assigned: 0 }], []];
    }
    if (!sql.includes('JOIN FTIPMV fe') || !sql.startsWith('SELECT')) throw new Error('Unexpected legacy query');
    return [runtime.enabled ? [{ enabled: 1 }] : [], []];
  } },
}));

vi.mock('../src/modules/general-data/users/infrastructure/legacy-user-directory.js', () => {
  const admin = { legacyId: 1, identification: 'admin', name: 'Administración', group: 0, active: true, shared: false };
  return { legacyUserDirectory: {
    users: async () => [admin],
    user: async (id: number) => id === 1 ? admin : undefined,
    permissions: async (group: number, keys?: string[]) => [
      { key: 'INICIO13', label: 'Datos Generales', allowed: group === 0, requiresSupervisor: false },
      { key: 'MCATALOGOS8', label: 'Usuarios', allowed: group === 0, requiresSupervisor: false },
      { key: 'MPED5', label: 'Autorizar', allowed: false, requiresSupervisor: false },
    ].filter(({ key }) => !keys || keys.includes(key)),
  } };
});

vi.mock('../src/modules/sales/orders/infrastructure/datasources/legacy-mysql-order-reference-data-source.js', () => ({
  LegacyMysqlOrderReferenceDataSource: class {
    async options() {
      return { warehouses: [{ code: '01', description: 'México' }], types: [], agents: [{ code: '1202', name: 'Ventas' }] };
    }
    async orderNumberSeries() {
      return { code: 'P', description: 'PEDIDO MEX', taxPercentage: 16, digits: 6, lastNumber: 19405 };
    }
    async customer() {
      return { id: 100, code: 'C001', name: 'Cliente de pruebas', agentCode: '1202', agentName: 'Ventas',
        termsDays: 30, classification: '', store: '', branches: [] };
    }
    async product() {
      return { id: 7, code: 'A', description: 'Producto A', unit: 'PZ', price: 50, cost: 25, costCurrencyId: 1,
        taxPercentage: 16, excisePercentage: 0, currencyId: 1, stock: 20, assigned: 0, available: 20 };
    }
    async canAuthorizeCustomer() { return true; }
    async authorizationCosts() { return new Map([[7, { cost: 25, costCurrencyId: 1 }]]); }
  },
}));

vi.mock('../src/modules/sales/invoicing/infrastructure/datasources/mysql-invoice-from-order-references.js', () => ({
  MysqlInvoiceFromOrderReferences: class {
    async context() {
      return { fiscalStart: '2025-01-01', fiscalEnd: '2025-12-31', reason: null, vat: 16, customerTermsDays: 30,
        creditLimit: 1000, creditBalance: 0, products: new Map([[7, { id: 7, code: 'A', unit: 'PZ', package: '', family: '',
          cost: 25, legacyOnHand: 20, legacyAssigned: 0, supported: true }]]) };
    }
  },
}));

const originalDate = '2025-11-20';
const currentDate = () => new Intl.DateTimeFormat('sv-SE', { dateStyle: 'short', timeZone: 'America/Mexico_City' }).format();
const root = '/api/sales/invoices';
const previewPath = (id: number) => `${root}/${id}/summaries/ticket-to-invoice`;

function assignedOrder(id: number): OrderProps {
  return {
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
  };
}

async function postFirstRemission(connect: PostgresConnectionFactory) {
  const orders = new PostgresOrderOverlayDataSource(connect, () => true);
  const sales = new PostgresSalesRemissions(orders, connect, { layers: async () => [] });
  const order = await orders.create(async (id) => assignedOrder(id));
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

it('propone la fecha de México sólo dentro del ejercicio fiscal, incluidos ambos extremos', async () => {
  const order = assignedOrder(1);
  const fiscalStart = '2025-01-01';
  const fiscalEnd = '2025-12-31';
  const useCase = new CreateInvoiceFromOrder({
    writable: () => true,
    order: async () => ({ order, revision: 1 }),
    findRequest: async () => null,
    commit: async () => { throw new Error('La preparación no debe registrar una remisión'); },
  }, { context: async () => ({
    fiscalStart, fiscalEnd, reason: null, vat: 16, customerTermsDays: 30, creditLimit: 1000,
    creditBalance: 0, products: new Map([[7, { id: 7, code: 'A', unit: 'PZ', package: '', family: '', cost: 25,
      legacyOnHand: 20, legacyAssigned: 0, supported: true }]]),
  }) });

  try {
    for (const [instant, issuedAt] of [
      ['2025-01-01T05:59:59Z', null],
      ['2025-01-01T06:00:00Z', fiscalStart],
      ['2026-01-01T05:59:59Z', fiscalEnd],
      ['2026-01-01T06:00:00Z', null],
    ] as const) {
      vi.setSystemTime(new Date(instant));
      await expect(useCase.prepare(1, order.number)).resolves.toMatchObject({
        canWrite: true, fiscalStart, fiscalEnd, defaults: { issuedAt },
      });
    }
  } finally { vi.useRealTimers(); }
});

it('captura, autoriza, remite parcialmente y factura un pedido con tres sesiones web', async () => {
  const db = new PGlite();
  try {
    runtime.connect.mockImplementation(async () => ({
      async query<T extends object>(sql: string, values?: unknown[]) {
        if (values) return db.query<T>(sql, values);
        return { rows: ((await db.exec(sql)).at(-1)?.rows ?? []) as T[] };
      },
      release() {},
    }));
    runtime.enabled = true;
    const api = request(createApp());
    const password = 'Prueba#6';
    const change = (verb: 'post' | 'patch', path: string, cookie?: string) => {
      const mutation = api[verb](path).set('Host', 'localhost:5173').set('Origin', 'http://localhost:5173');
      return cookie ? mutation.set('Cookie', cookie) : mutation;
    };
    const activate = (token: string) => change('post', '/api/session/activation').send({ token, password }).expect(204);
    const login = async (identification: string) => {
      const { headers } = await change('post', '/api/session').send({ identification, password }).expect(200);
      return (headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!;
    };
    await activate((await webAccess.bootstrapAdministrator(1, 'administracion-web')).token);
    const admin = await login('administracion-web');
    const users = '/api/general-data/users';
    const createUser = async (identification: string, name: string, group: number) => {
      const { body: { data: user } } = await change('post', users, admin)
        .send({ identification, name, group, active: true, administrator: false }).expect(201);
      const activation = await change('post', `${users}/${user.id}/activation`, admin)
        .send({ revision: user.revision }).expect(200);
      await activate(activation.body.data.token);
      return { id: user.id, session: await login(identification) };
    };
    const seller = await createUser('vendedor', 'Vendedor', 4);
    const approver = await createUser('autorizador', 'Autorizador', 18);
    const biller = await createUser('facturador', 'Facturador', 5);
    await change('patch', '/api/general-data/permission-groups/18', admin)
      .send({ revision: 0, changes: [{ key: 'MPED5', allowed: true }] }).expect(200);

    const orders = '/api/sales/orders';
    const { body: { data: order } } = await change('post', `${orders}/capture`, seller.session).send({
      warehouse: '01', typeCode: 'P', customerCode: 'C001', orderedAt: originalDate, from: originalDate, dueAt: originalDate,
      agentCode: '1202', termsDays: 30, store: '', documentKind: 'order',
      lines: [{ productCode: 'A', quantity: 3, price: 50 }],
    }).expect(201);
    const authorization = `${orders}/${order.id}/actions/authorization`;
    const decision = { authorized: true, revision: order.storage.revision };
    const denied = await change('post', authorization, seller.session).send(decision).expect(403);
    expect(denied.body.error.code).toBe('ORDER_APPROVER_FORBIDDEN');
    const { body: { data: approved } } = await change('post', authorization, approver.session).send(decision).expect(200);
    expect(approved).toMatchObject({ authorization: 'O.K.', authorizedByName: 'Autorizador', authorizedByWebUserId: approver.id });

    await change('post', `${orders}/${order.id}/actions/assignment`, approver.session)
      .send({ lines: [{ lineId: order.lines[0].id, assigned: 3 }] }).expect(200);
    const remissions = `${root}/from-order`;
    const { body: { data: ready } } = await api.get(remissions).set('Cookie', biller.session).query({ orderNumber: order.number }).expect(200);
    expect(ready).toMatchObject({ canWrite: true, fiscalStart: '2025-01-01', fiscalEnd: '2025-12-31', lines: [{ maximum: 3 }] });
    const issue = { orderNumber: order.number, revision: ready.revision, issuedAt: originalDate,
      requestKey: randomUUID(), lines: [{ orderLineId: order.lines[0].id, quantity: 2 }] };
    await change('post', remissions, biller.session).send({ ...issue, issuedAt: '2026-01-01' }).expect(422);
    const { body: { data: posted } } = await change('post', remissions, biller.session).send(issue).expect(201);
    expect(posted).toMatchObject({ orderComplete: false, invoice: { orderNumber: order.number, totals: { total: 116 } } });
    expect((await change('post', remissions, biller.session).send(issue).expect(201)).body.data).toEqual(posted);

    const { invoice } = posted;
    const { body: { data: offer } } = await api.get(previewPath(invoice.id)).set('Cookie', biller.session).expect(200);
    const conversion = { expectedVersion: offer.ticketConversion.version, requestKey: randomUUID() };
    const { body: { data: converted } } = await change('post', previewPath(invoice.id), biller.session).send(conversion).expect(201);
    expect(converted).toMatchObject({ sourceNumber: invoice.number, number: expect.stringMatching(/^FEW\d{8}$/) });
    expect((await change('post', previewPath(invoice.id), biller.session).send(conversion).expect(201)).body.data).toEqual(converted);
    expect((await api.get(`${root}/${invoice.id}`).set('Cookie', biller.session).expect(200)).body.data).toMatchObject({
      number: converted.number, cfdStatus: '1', totals: { total: 116, balance: 116, paid: 0 },
    });

    const { body: { data: partial } } = await api.get(`${orders}/${order.id}`).set('Cookie', seller.session).expect(200);
    expect(partial).toMatchObject({ authorization: 'O.K.', authorizedByWebUserId: approver.id,
      lines: [{ ordered: 3, fulfilled: 2, remaining: 1, assigned: 1 }] });
    const movement = await api.get(`/api/inventories/movements/${invoice.id}`).set('Cookie', biller.session).expect(200);
    expect(movement.body.data).toMatchObject({ header: { document: converted.number, reference: order.number, warehouse: '01' },
      lines: [{ productId: 7, quantity: -2 }], totals: { quantity: -2 } });
    const stock = await db.query('SELECT product_id::int AS product, warehouse, quantity::float8 FROM tuvansa.sales_remission_inventory');
    expect(stock.rows).toEqual([{ product: 7, warehouse: '01', quantity: -2 }]);
    const charges = await db.query('SELECT charge::float8 FROM tuvansa.sales_remissions');
    expect(charges.rows).toEqual([{ charge: 116 }]);
    const auxiliary = await api.get(`${root}/${invoice.id}/actions/auxiliary`).set('Cookie', biller.session).expect(200);
    expect(auxiliary.body.data).toMatchObject({ summary: { charges: 116, credits: 0, balance: 116 }, items: [{ amount: 116 }] });
  } finally {
    await db.close();
  }
}, 30_000);

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
    const api = request(createApp((_request, _response, next) => next()));
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
