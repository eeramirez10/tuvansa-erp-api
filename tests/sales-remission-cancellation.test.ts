import { PGlite } from '@electric-sql/pglite';
import { expect, it } from 'vitest';
import { CaptureCustomerCollection } from '../src/modules/accounts-receivable/clients/application/use-cases/capture-customer-collection.js';
import { ReverseCustomerCollection } from '../src/modules/accounts-receivable/clients/application/use-cases/reverse-customer-collection.js';
import { salesRemissionsOutstanding } from '../src/modules/accounts-receivable/clients/infrastructure/datasources/customer-collections-reads.js';
import { PostgresCustomerCollections } from '../src/modules/accounts-receivable/clients/infrastructure/datasources/postgres-customer-collections.js';
import { PostgresCustomerCollectionReversals } from '../src/modules/accounts-receivable/clients/infrastructure/datasources/postgres-customer-collection-reversals.js';
import { CancelSalesRemission } from '../src/modules/sales/invoicing/application/use-cases/cancel-sales-remission.js';
import type { SalesRemissionCancellationInput } from '../src/modules/sales/invoicing/domain/datasources/sales-remission-cancellation-data-source.js';
import { postInvoiceFromOrder } from '../src/modules/sales/invoicing/domain/entities/invoice-from-order.js';
import { PostgresSalesRemissionCancellations } from '../src/modules/sales/invoicing/infrastructure/datasources/postgres-sales-remission-cancellations.js';
import { PostgresSalesRemissions } from '../src/modules/sales/invoicing/infrastructure/datasources/postgres-sales-remissions.js';
import { PostgresSalesStampingSimulations } from '../src/modules/sales/invoicing/infrastructure/datasources/postgres-sales-stamping-simulations.js';
import type { OrderProps } from '../src/modules/sales/orders/domain/entities/order.js';
import { PostgresOrderOverlayDataSource } from '../src/modules/sales/orders/infrastructure/datasources/postgres-order-overlay-data-source.js';
import { hasLocalSalesStock } from '../src/modules/sales/orders/infrastructure/datasources/sales-order-inventory-stock.js';
import type { PostgresConnectionFactory } from '../src/shared/infrastructure/database/postgres-pool.js';

it('cancels local FAW through K, protects fiscal and PA records, and regenerates the pedido only by choice', async () => {
  const db = new PGlite();
  const connect: PostgresConnectionFactory = async () => ({
    async query<T extends object>(sql: string, values?: unknown[]) {
      if (values) return db.query<T>(sql, values);
      const results = await db.exec(sql);
      return { rows: (results.at(-1)?.rows ?? []) as T[] };
    },
    release() {},
  });
  const companyId = 1;
  const customerId = 100;
  const userId = 2;
  const issuedAt = '2025-12-01';
  const fiscal = { fiscalStart: '2025-01-01', fiscalEnd: '2025-12-31' };
  const orders = new PostgresOrderOverlayDataSource(connect, () => true);
  const sales = new PostgresSalesRemissions(orders, connect);
  const storage = new PostgresSalesRemissionCancellations(orders, connect, () => true);
  const cancellations = new CancelSalesRemission(storage, { fiscalWindow: async () => fiscal });
  const simulations = new PostgresSalesStampingSimulations(connect);
  const orderFor = (id: number): OrderProps => ({
    id, number: `PW${id}`, customerOrderNumber: '', documentKind: 'order', status: '', fulfilledAmount: 0,
    customer: { id: customerId, code: 'C001', name: 'Cliente' }, branch: 0, department: '',
    dates: { orderedAt: issuedAt, from: null, dueAt: null }, attention: '', termsDays: 5, authorization: 'O.K.',
    initial: false, warehouse: '01', currencyId: 0, exchangeRate: 1, minimumFulfillmentPercentage: 0, observations: '',
    classifications: [], captureDetails: { boxes: 0, collectionCurrency: 'PESOS', commission: 0, noPartialDeliveries: false,
      transportation: '', deliveryAddress: ['', '', ''], contact: '', additionalComments: '' },
    totals: { quantity: 4, ordered: 4, fulfilled: 0, remaining: 4, subtotal: 200, discount: 0,
      freight: 0, insurance: 0, other: 0, tax: 32, total: 232 },
    lines: [{ id: 101, productId: 7, productCode: 'A', description: 'Producto A', ordered: 4,
      fulfilled: 0, remaining: 4, unit: 'PZ', assigned: 4, branch: 0, price: 50, classCode: '', currencyId: 0,
      piecesAssignment: '', discount: 0, publicPrice: 50, sku: '', color: '', size: '' }],
  });
  const post = async (requestKey: string) => {
    const order = await orders.create(async (id) => orderFor(id));
    const capture = { orderNumber: order.number, requestKey, revision: 1, issuedAt, lines: [{ orderLineId: 101, quantity: 2 }] };
    const { invoice } = await sales.commit({ companyId, userId, requestKey, orderId: order.id,
      orderNumber: order.number, revision: 1, fingerprint: 'c'.repeat(64), post: async (current, balance) => postInvoiceFromOrder(current, {
        ...fiscal, reason: null, vat: 16, customerTermsDays: 5, creditLimit: 1000, creditBalance: 0,
        products: new Map([[7, { id: 7, code: 'A', unit: 'PZ', package: '', family: '', cost: 25, legacyOnHand: 20, legacyAssigned: 0, supported: true }]]),
      }, capture, companyId, userId, balance ?? 0) });
    return { order, invoice };
  };

  try {
    const first = await post('0ca70eff-4c8f-42a2-ad2a-81157e3a1c19');
    const second = await post('60e7eb04-942b-4992-83be-56f2305cf9a8');
    const fiscalDocument = await post('b20aa161-46fe-4cca-a788-8e2bd57f0cec');
    const input: SalesRemissionCancellationInput = {
      requestKey: '9590bccd-20ac-4100-836e-ed03aad1e662', date: '2025-12-10', reason: 'Error de remisión', confirmed: true, regenerateOrder: true,
    };
    const { id, number } = first.invoice;
    expect(await cancellations.prepare(companyId, id)).toMatchObject({ canWrite: true, amount: 116, order: { canRegenerate: true } });
    expect((await db.query("SELECT to_regclass('tuvansa.sales_remission_cancellations') AS present")).rows).toEqual([{ present: null }]);
    await expect(cancellations.save(companyId, userId, id, { ...input, date: '2025-11-30' }))
      .rejects.toMatchObject({ code: 'SALES_REMISSION_CANCELLATION_INVALID_DATE' });
    await expect(cancellations.save(companyId, userId, id, { ...input, date: '2026-01-01' }))
      .rejects.toMatchObject({ code: 'SALES_REMISSION_CANCELLATION_INVALID_DATE' });

    await db.query(`UPDATE tuvansa.sales_remissions SET result=jsonb_set(result,'{invoice,cfdStatus}','"1"') WHERE id=$1`, [fiscalDocument.invoice.id]);
    expect(await cancellations.prepare(companyId, fiscalDocument.invoice.id)).toMatchObject({ canWrite: false, reason: expect.stringContaining('fiscal') });
    await db.query(`UPDATE tuvansa.sales_remissions SET result=jsonb_set(jsonb_set(result,'{invoice,cfdStatus}','"0"'),'{invoice,folio}', '"FISCAL-UUID"') WHERE id=$1`, [fiscalDocument.invoice.id]);
    await expect(cancellations.save(companyId, userId, fiscalDocument.invoice.id, input)).rejects.toMatchObject({ code: 'SALES_REMISSION_CANCELLATION_BLOCKED' });

    const capture = new CaptureCustomerCollection(new PostgresCustomerCollections(connect, () => true), {
      settings: async () => ({ ...fiscal, policyType: '1', clientAccount: '1105001', clientAccountName: 'Clientes',
        bankAccounts: [{ id: 6610, code: '1102100001', name: 'Banco' }] }),
    });
    const identity = { companyId, clientId: customerId, remissionId: second.invoice.id };
    const pa = await capture.save(identity, userId, { requestKey: crypto.randomUUID(), bankAccountId: 6610,
      date: '2025-12-02', revision: 1, amount: 1, description: '', reference: '' });
    expect(await cancellations.prepare(companyId, second.invoice.id)).toMatchObject({ canWrite: false, reason: expect.stringContaining('cobro PA') });
    await expect(cancellations.save(companyId, userId, second.invoice.id, input)).rejects.toMatchObject({ code: 'SALES_REMISSION_CANCELLATION_BLOCKED' });
    const reverse = new ReverseCustomerCollection(new PostgresCustomerCollectionReversals(connect, () => true), { fiscalWindow: async () => fiscal });
    await reverse.save({ companyId, clientId: customerId, collectionId: pa.id }, userId, {
      requestKey: crypto.randomUUID(), date: '2025-12-09', reason: 'Depósito duplicado', confirmed: true,
    });
    await expect(cancellations.save(companyId, userId, second.invoice.id, { ...input, date: '2025-12-08' }))
      .rejects.toMatchObject({ code: 'SALES_REMISSION_CANCELLATION_INVALID_DATE' });

    const simulated = await simulations.record(id, `SIM-FE-${number}`);
    const canceled = await cancellations.save(companyId, userId, id, input);
    expect(canceled).toEqual({ id: 7960000000000, date: input.date, reason: input.reason, regeneratedOrder: true });
    expect(await simulations.find(id)).toEqual(simulated);
    await expect(simulations.record(id, `SIM-FE-${number}`)).rejects.toMatchObject({ code: 'STAMPING_SIMULATION_INELIGIBLE' });
    expect(await cancellations.save(companyId, userId, id, input)).toEqual(canceled);
    await expect(cancellations.save(companyId, userId, id, { ...input, regenerateOrder: false })).rejects.toMatchObject({ code: 'SALES_REMISSION_CANCELLATION_REQUEST_CONFLICT' });
    expect(await orders.get(first.order.id)).toMatchObject({ revision: 3, document: { status: '', fulfilledAmount: 0,
      lines: [{ fulfilled: 0, remaining: 4, assigned: 2 }] } });

    const retained = await cancellations.save(companyId, userId, second.invoice.id, { ...input, regenerateOrder: false, requestKey: '38dd9f7a-c18a-4fc7-80ea-69d528e715d0' });
    expect(retained.regeneratedOrder).toBe(false);
    expect(await orders.get(second.order.id)).toMatchObject({ revision: 2, document: { status: 'SURT', fulfilledAmount: 100,
      lines: [{ fulfilled: 2, remaining: 2, assigned: 2 }] } });
    const client = await connect();
    expect(await salesRemissionsOutstanding(client, companyId, customerId)).toBe(116);
    expect(await hasLocalSalesStock(client)).toMatchObject({ remissionCancellations: true });
    expect((await db.query('SELECT quantity::float8 AS quantity FROM tuvansa.sales_remission_cancellation_inventory ORDER BY cancellation_id')).rows)
      .toEqual([{ quantity: 2 }, { quantity: 2 }]);
    expect((await db.query('SELECT movement FROM tuvansa.sales_remission_cancellations WHERE id=$1', [canceled.id])).rows)
      .toMatchObject([{ movement: { header: { type: 'K', document: 'KWV00000001', reference: number },
        lines: [{ quantity: 2, type: 'K' }], totals: { quantity: 2, cost: 50 } } }]);
    expect((await db.query('SELECT count(*)::integer AS originals FROM tuvansa.sales_remissions')).rows).toEqual([{ originals: 3 }]);
  } finally { await db.close(); }
}, 15000);
