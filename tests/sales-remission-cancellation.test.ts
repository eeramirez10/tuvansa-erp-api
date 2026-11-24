import { PGlite } from '@electric-sql/pglite';
import { expect, it, vi } from 'vitest';
import { CaptureCustomerCollection } from '../src/modules/accounts-receivable/clients/application/use-cases/capture-customer-collection.js';
import { ReverseCustomerCollection } from '../src/modules/accounts-receivable/clients/application/use-cases/reverse-customer-collection.js';
import { salesRemissionsOutstanding } from '../src/modules/accounts-receivable/clients/infrastructure/datasources/customer-collections-reads.js';
import { PostgresCustomerCollections } from '../src/modules/accounts-receivable/clients/infrastructure/datasources/postgres-customer-collections.js';
import { PostgresCustomerCollectionReversals } from '../src/modules/accounts-receivable/clients/infrastructure/datasources/postgres-customer-collection-reversals.js';
import { currentAdjustmentLayers, inactivePepsOrder, type AdjustmentLayer } from '../src/modules/inventories/movements/infrastructure/datasources/inventory-adjustment-layers.js';
import { LegacyMysqlMovementsDataSource } from '../src/modules/inventories/movements/infrastructure/datasources/legacy-mysql-movements-data-source.js';
import { MysqlInventoryAdjustmentReferences } from '../src/modules/inventories/movements/infrastructure/datasources/mysql-inventory-adjustment-references.js';
import { CancelSalesRemission } from '../src/modules/sales/invoicing/application/use-cases/cancel-sales-remission.js';
import type { SalesRemissionCancellationInput } from '../src/modules/sales/invoicing/domain/datasources/sales-remission-cancellation-data-source.js';
import { Invoice } from '../src/modules/sales/invoicing/domain/entities/invoice.js';
import { postInvoiceFromOrder } from '../src/modules/sales/invoicing/domain/entities/invoice-from-order.js';
import { LegacyMysqlInvoicesDataSource } from '../src/modules/sales/invoicing/infrastructure/datasources/legacy-mysql-invoices-data-source.js';
import { MysqlHistoricalSalesRemissionCancellationSource } from '../src/modules/sales/invoicing/infrastructure/datasources/mysql-historical-sales-remission-cancellation-source.js';
import { PostgresSalesRemissionCancellations } from '../src/modules/sales/invoicing/infrastructure/datasources/postgres-sales-remission-cancellations.js';
import { PostgresSalesRemissions } from '../src/modules/sales/invoicing/infrastructure/datasources/postgres-sales-remissions.js';
import { PostgresSalesStampingSimulations } from '../src/modules/sales/invoicing/infrastructure/datasources/postgres-sales-stamping-simulations.js';
import { historicalSalesRemissionCancellationsOn } from '../src/modules/sales/invoicing/infrastructure/datasources/sales-remission-cancellation-reads.js';
import { Order, type OrderProps } from '../src/modules/sales/orders/domain/entities/order.js';
import { LegacyMysqlOrdersDataSource } from '../src/modules/sales/orders/infrastructure/datasources/legacy-mysql-orders-data-source.js';
import { PostgresOrderOverlayDataSource } from '../src/modules/sales/orders/infrastructure/datasources/postgres-order-overlay-data-source.js';
import { hasLocalSalesStock } from '../src/modules/sales/orders/infrastructure/datasources/sales-order-inventory-stock.js';
import { legacyMysqlPool } from '../src/shared/infrastructure/database/legacy-mysql-pool.js';
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
  const layer = { productId: 7, date: '2025-11-25', cost: 22, adValorem: 0, document: 'RA123',
    customsEntry: 'PED123', customsOffice: '240', expiresAt: null, lot: '', number: '', location: '' };
  const opened: AdjustmentLayer[] = [
    { ...layer, id: 100, warehouse: '11', initial: 1, available: 1, layerOrder: 1 },
    { ...layer, id: 101, warehouse: '01', initial: 2, available: 2, layerOrder: 2 },
  ];
  const layers = { layers: async () => opened };
  const sales = new PostgresSalesRemissions(orders, connect, layers);
  const storage = new PostgresSalesRemissionCancellations(orders, connect, () => true, undefined, layers);
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

    const pepsOrder = await orders.create(async (id) => orderFor(id));
    const remit = (quantity: number, key: string) => sales.commit({
      companyId, userId, requestKey: key, orderId: pepsOrder.id, orderNumber: pepsOrder.number,
      revision: 1, fingerprint: 'a'.repeat(64),
      post: async (current, balance) => postInvoiceFromOrder(current, {
        ...fiscal, reason: null, vat: 16, customerTermsDays: 5, creditLimit: 1000, creditBalance: 0,
        products: new Map([[7, { id: 7, code: 'A', unit: 'PZ', package: '', family: '', cost: 25,
          legacyOnHand: 20, legacyAssigned: 0, supported: true, pepsCostBasis: { average: 30, last: 22, adValorem: 0.125 } }]]),
      }, { orderNumber: pepsOrder.number, revision: 1, requestKey: key, issuedAt, lines: [{ orderLineId: 101, quantity }] },
      companyId, userId, balance ?? 0),
    });
    const opening = await currentAdjustmentLayers(client, [7], opened);
    await expect(remit(4, crypto.randomUUID())).rejects.toMatchObject({ code: 'INVENTORY_ADJUSTMENT_LAYER_INSUFFICIENT' });
    expect(await currentAdjustmentLayers(client, [7], opened)).toEqual(opening);
    expect(await orders.get(pepsOrder.id)).toMatchObject({ revision: 1 });
    expect(await salesRemissionsOutstanding(client, companyId, customerId)).toBe(116);

    const key = crypto.randomUUID();
    const partial = await remit(2, key);
    expect(await remit(2, key)).toEqual(partial);
    expect(partial).toMatchObject({
      orderComplete: false, invoice: { totals: { total: 116, fulfilledQuantity: 2 }, lines: [
        { fulfilledQuantity: 1, quantity: -1, cost: 30.125, amount: 50, inventoryLayer: { id: 100, warehouse: '11', customsEntry: 'PED123' } },
        { fulfilledQuantity: 1, quantity: -1, cost: 30.125, amount: 50, inventoryLayer: { id: 101, warehouse: '01' } },
      ] },
    });
    expect(await orders.get(pepsOrder.id)).toMatchObject({ revision: 2, document: {
      fulfilledAmount: 100, lines: [{ fulfilled: 2, remaining: 2, assigned: 2 }],
    } });
    expect(await currentAdjustmentLayers(client, [7], opened)).toMatchObject([
      { id: 100, available: 0, layerOrder: inactivePepsOrder }, { id: 101, available: 1, layerOrder: 2 },
    ]);
    expect(await salesRemissionsOutstanding(client, companyId, customerId)).toBe(232);

    const pepsId = partial.invoice.id;
    expect(await cancellations.prepare(companyId, pepsId)).toMatchObject({ canWrite: true, order: { canRegenerate: true } });
    const pepsInput = { ...input, requestKey: crypto.randomUUID() };
    const returned = await cancellations.save(companyId, userId, pepsId, pepsInput);
    expect(await cancellations.save(companyId, userId, pepsId, pepsInput)).toEqual(returned);
    expect(await orders.get(pepsOrder.id)).toMatchObject({ revision: 3, document: {
      fulfilledAmount: 0, lines: [{ fulfilled: 0, remaining: 4, assigned: 2 }],
    } });
    expect(await salesRemissionsOutstanding(client, companyId, customerId)).toBe(116);
    expect(await currentAdjustmentLayers(client, [7], opened)).toMatchObject([
      { id: 100, available: 1, initial: 1, layerOrder: 3 }, { id: 101, available: 2, initial: 2, layerOrder: 2 },
    ]);
    expect((await db.query('SELECT movement FROM tuvansa.sales_remission_cancellations WHERE id=$1', [returned.id])).rows)
      .toMatchObject([{ movement: { lines: [
        { quantity: 1, type: 'K', lotId: 100, warehouse: '01', lotWarehouse: '11' },
        { quantity: 1, type: 'K', lotId: 101, warehouse: '01', lotWarehouse: '01' },
      ], totals: { quantity: 2, cost: 60.25 } } }]);
    expect((await db.query(`SELECT count(*)::int AS count,sum(quantity)::float8 AS balance
      FROM tuvansa.inventory_adjustment_layer_stock WHERE remission_id=$1`, [pepsId])).rows).toEqual([{ count: 4, balance: 0 }]);
  } finally { await db.close(); }
}, 15000);

it.each([false, true])('reverses a historical MXN remission and regenerates the original order (PEPS: %s)', async (peps) => {
  const db = new PGlite();
  const connect: PostgresConnectionFactory = async () => ({
    async query<T extends object>(sql: string, values?: unknown[]) {
      if (values) return db.query<T>(sql, values);
      const results = await db.exec(sql);
      return { rows: (results.at(-1)?.rows ?? []) as T[] };
    },
    release() {},
  });
  const fiscal = { fiscalStart: '2025-01-01', fiscalEnd: '2025-12-31' };
  const date = '2025-02-28';
  const customerId = 100;
  const productId = 7;
  const orderLineId = 177;
  const invoiceId = 346421;
  const invoiceNumber = 'FA25675';
  const order: OrderProps = {
    id: 55, number: 'P055', customerOrderNumber: '', documentKind: 'order', status: 'SURT', fulfilledAmount: 50,
    customer: { id: customerId, code: 'C001', name: 'Cliente' }, branch: 0, department: '',
    dates: { orderedAt: date, from: null, dueAt: null }, attention: '', termsDays: 5, authorization: 'O.K.',
    initial: false, warehouse: '01', currencyId: 1, exchangeRate: 1, minimumFulfillmentPercentage: 0,
    observations: '', classifications: [],
    totals: { quantity: 4, ordered: 4, fulfilled: 1, remaining: 3, subtotal: 200, discount: 0,
      freight: 0, insurance: 0, other: 0, tax: 32, total: 232 },
    lines: [{ id: orderLineId, productId, productCode: 'A', description: 'Producto A', ordered: 4,
      fulfilled: 1, remaining: 3, unit: 'PZ', assigned: 3, branch: 0, price: 50, classCode: '', currencyId: 1,
      piecesAssignment: '', discount: 0, publicPrice: 50, sku: '', color: '', size: '' }],
  };
  const posted = postInvoiceFromOrder({
    ...order, currencyId: 0, lines: order.lines.map((line) => ({ ...line, currencyId: 0 })),
    captureDetails: { boxes: 0, collectionCurrency: 'PESOS', commission: 0, noPartialDeliveries: false,
      transportation: '', deliveryAddress: ['', '', ''], contact: '', additionalComments: '' },
  }, {
    ...fiscal, reason: null, vat: 16, customerTermsDays: 5, creditLimit: 1000, creditBalance: 0,
    products: new Map([[productId, { id: productId, code: 'A', unit: 'PZ', package: '', family: '', cost: 25,
      legacyOnHand: 20, legacyAssigned: 3, supported: true }]]),
  }, { orderNumber: order.number, requestKey: crypto.randomUUID(), revision: 0, issuedAt: date,
    lines: [{ orderLineId, quantity: 2 }] }, 1, 0);
  const nativeOrder = { ...posted.order, currencyId: 1, lines: posted.order.lines.map((line) => ({ ...line, currencyId: 1 })) };
  const layer = { productId, date: null, cost: 24, adValorem: 0, document: 'RA123', customsEntry: '',
    customsOffice: '', expiresAt: null, lot: '', number: '', location: '' };
  const opened: AdjustmentLayer[] = [
    { ...layer, id: 14484, warehouse: '01', initial: 1, available: 0, layerOrder: inactivePepsOrder },
    { ...layer, id: 14556, warehouse: '12', initial: 5, available: 4, layerOrder: 2 },
  ];
  const inventory = (peps ? opened.map(({ id }) => ({ lotId: id, units: 1 })) : [{ lotId: 0, units: 2 }])
    .map(({ lotId, units }, index) => ({
      id: 333 + index, type: 'FA', productId, warehouse: '01', unit: 'PZ', factor: 1, quantity: -units,
      invoiced: units, price: 50, cost: 25, lotId, pieces: '', productType: 1, productUnit: 'PZ', piecesControl: 0,
      noLayers: peps ? 0 : 1, orderLineId, orderedProduct: productId, orderedUnit: 'PZ', orderedFactor: 1,
      orderId: order.id, orderNumber: order.number, orderCustomerId: customerId,
    }));
  const header = {
    number: invoiceNumber, type: 'FA', issuedAt: date, customerId, orderNumber: order.number, warehouse: '01',
    currencyId: 1, exchangeRate: 1, total: 116, balance: 116, billed: 1, inventoried: 1, receivable: 1,
    canceled: 0, fiscalStatus: 0, fiscalEvidence: 0, specialAccounting: 0, multiplePages: 0, hasPieces: 0,
    hasRecadv: 0, hasLinkedAccounting: 0, ordinaryMovement: 1, multiWarehouse: '1', automaticPeps: Number(peps),
  };
  const charge = { id: 1, type: 'FA', amount: 116, date, reference: order.number,
    exchangeRate: 1, customerId, supplierId: 0, specialPosting: 0 };
  const queries = vi.spyOn(legacyMysqlPool, 'execute').mockImplementation(async (sql) => {
    const statement = String(sql);
    const rows = statement.includes('FROM FDOC D JOIN FCIA c') ? [header]
      : statement.includes('FROM FAX WHERE') ? [charge]
        : statement.includes('FROM FAXINV A LEFT JOIN FINV I') ? inventory : null;
    if (!rows) throw new Error('Unexpected native query: ' + statement);
    return [rows, []] as unknown as Awaited<ReturnType<typeof legacyMysqlPool.execute>>;
  });
  const invoices = vi.spyOn(LegacyMysqlInvoicesDataSource.prototype, 'findById').mockResolvedValue(Invoice.create({
    ...posted.invoice, id: invoiceId, number: invoiceNumber, lines: inventory.map(({ id, quantity, invoiced }) => ({
      ...posted.invoice.lines[0]!, id, quantity, fulfilledQuantity: invoiced, amount: 50 * invoiced,
    })),
  }));
  const movements = vi.spyOn(LegacyMysqlMovementsDataSource.prototype, 'findById').mockResolvedValue({
    ...posted.movement, header: { ...posted.movement.header, id: invoiceId, document: invoiceNumber },
    lines: inventory.map(({ id, quantity, lotId }) => ({ ...posted.movement.lines[0]!, id, quantity, lotId })),
  });
  const nativeOrders = vi.spyOn(LegacyMysqlOrdersDataSource.prototype, 'findById').mockResolvedValue(Order.create(nativeOrder));
  const layerReference = vi.spyOn(MysqlInventoryAdjustmentReferences.prototype, 'layers')
    .mockImplementation(async (ids) => opened.filter(({ productId }) => ids.includes(productId)));
  const orders = new PostgresOrderOverlayDataSource(connect, () => true);
  const native = new MysqlHistoricalSalesRemissionCancellationSource();
  let concurrentChange = false;
  let reads = 0;
  let missingDuringWrite = false;
  const storage = new PostgresSalesRemissionCancellations(orders, connect, () => true, {
    read: async (id) => {
      const source = await native.read(id);
      if (source?.historical && concurrentChange && ++reads === 2) source.historical.version = 'changed recently';
      return source;
    },
  }, { layers: async () => missingDuringWrite ? opened.slice(1) : opened });
  const cancel = new CancelSalesRemission(storage, { fiscalWindow: async () => fiscal });
  const input: SalesRemissionCancellationInput = {
    requestKey: 'aabb4403-d213-44ab-acd8-6bad5afd5812', date: '2025-03-03', reason: 'Remisión histórica de prueba',
    confirmed: true, regenerateOrder: true,
  };
  try {
    if (peps) {
      header.automaticPeps = 0;
      expect(await cancel.prepare(1, invoiceId)).toMatchObject({ canWrite: false, reason: expect.stringContaining('capas PEPS') });
      header.automaticPeps = 1;
      nativeOrders.mockResolvedValueOnce(Order.create({ ...nativeOrder, lines: [{ ...nativeOrder.lines[0]!, fulfilled: 1 }] }));
      expect(await cancel.prepare(1, invoiceId)).toMatchObject({ canWrite: true, order: { canRegenerate: false } });
    }
    expect(await cancel.prepare(1, invoiceId)).toMatchObject({ canWrite: true, order: { canRegenerate: true } });
    expect((await db.query("SELECT to_regclass('tuvansa.sales_remissions') AS present")).rows).toEqual([{ present: null }]);
    concurrentChange = true;
    await expect(cancel.save(1, 0, invoiceId, input)).rejects.toMatchObject({ code: 'SALES_REMISSION_SOURCE_CHANGED' });
    expect(await orders.get(order.id)).toBeNull();
    concurrentChange = false;
    const client = await connect();
    if (peps) {
      missingDuringWrite = true;
      await expect(cancel.save(1, 0, invoiceId, input)).rejects.toMatchObject({ code: 'INVENTORY_ADJUSTMENT_LAYER_MISSING' });
      expect(await orders.get(order.id)).toBeNull();
      expect(await salesRemissionsOutstanding(client, 1, customerId)).toBe(0);
      expect(await currentAdjustmentLayers(client, [productId], opened)).toEqual(opened);
      missingDuringWrite = false;
    }
    const saved = await cancel.save(1, 0, invoiceId, input);
    expect(saved.regeneratedOrder).toBe(true);
    expect(await cancel.save(1, 0, invoiceId, { ...input, requestKey: input.requestKey.toUpperCase() })).toEqual(saved);
    expect(await cancel.prepare(1, invoiceId)).toMatchObject({ canWrite: false, alreadyRecorded: saved });
    expect(await orders.get(order.id)).toMatchObject({ revision: 1, base: nativeOrder, document: {
      fulfilledAmount: 50, status: '', lines: [{ fulfilled: 1, remaining: 3, assigned: 1 }] },
    });
    expect(await salesRemissionsOutstanding(client, 1, customerId)).toBe(-116);
    expect(await historicalSalesRemissionCancellationsOn(client, { invoiceIds: [invoiceId] }))
      .toMatchObject([{ amount: 116, invoiceId, result: saved }]);
    expect((await db.query('SELECT ordered::float8 FROM tuvansa.order_stock_deltas')).rows).toEqual([{ ordered: 2 }]);
    expect((await db.query('SELECT quantity::float8 FROM tuvansa.sales_remission_cancellation_inventory')).rows).toEqual([{ quantity: 2 }]);
    expect((await db.query('SELECT * FROM tuvansa.sales_remissions')).rows).toEqual([]);
    if (peps) {
      expect(await currentAdjustmentLayers(client, [productId], opened)).toMatchObject([
        { id: 14484, initial: 1, available: 1, layerOrder: 3 }, { id: 14556, initial: 5, available: 5, layerOrder: 2 },
      ]);
      expect((await db.query(`SELECT layer_id::float8 AS id,warehouse,reversal,quantity::float8
        FROM tuvansa.inventory_adjustment_layer_stock WHERE remission_cancellation_id=$1 ORDER BY layer_id`, [saved.id])).rows)
        .toEqual([{ id: 14484, warehouse: '01', reversal: true, quantity: 1 }, { id: 14556, warehouse: '12', reversal: true, quantity: 1 }]);
      expect((await db.query('SELECT movement FROM tuvansa.sales_remission_cancellations WHERE id=$1', [saved.id])).rows)
        .toMatchObject([{ movement: { lines: [
          { quantity: 1, type: 'K', lotId: 14484, warehouse: '01', lotWarehouse: '01' },
          { quantity: 1, type: 'K', lotId: 14556, warehouse: '01', lotWarehouse: '12' },
        ] } }]);
    }
  } finally {
    queries.mockRestore();
    invoices.mockRestore();
    movements.mockRestore();
    nativeOrders.mockRestore();
    layerReference.mockRestore();
    await db.close();
  }
}, 15000);
