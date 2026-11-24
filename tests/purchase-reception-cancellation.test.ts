import { PGlite } from '@electric-sql/pglite';
import { expect, it, vi } from 'vitest';
import { currentAdjustmentLayers, inactivePepsOrder } from '../src/modules/inventories/movements/infrastructure/datasources/inventory-adjustment-layers.js';
import { PostgresInventoryAdjustmentsDataSource } from '../src/modules/inventories/movements/infrastructure/datasources/postgres-inventory-adjustments.js';
import { inventoryPepsCostsOn } from '../src/modules/inventories/movements/infrastructure/datasources/postgres-inventory-peps-cost.js';
import { PurchaseOrder, type PurchaseOrderProps } from '../src/modules/purchasing/purchase-orders/domain/entities/purchase-order.js';
import { PostgresPurchaseOrderEdits } from '../src/modules/purchasing/purchase-orders/infrastructure/datasources/postgres-purchase-order-edits.js';
import { CancelPurchaseReception } from '../src/modules/purchasing/purchase-receptions/application/use-cases/cancel-purchase-reception.js';
import type { ReceiptCancellationSource } from '../src/modules/purchasing/purchase-receptions/domain/datasources/purchase-reception-cancellation-data-source.js';
import type { PurchaseReceptionPosting } from '../src/modules/purchasing/purchase-receptions/domain/datasources/purchase-reception-write-data-source.js';
import { applyPurchaseOrderReceipt } from '../src/modules/purchasing/purchase-receptions/domain/entities/purchase-reception-order-effect.js';
import { historicalReceptionCancellationsOn } from '../src/modules/purchasing/purchase-receptions/infrastructure/datasources/historical-purchase-reception-cancellation-reads.js';
import { localPurchasePayablesSql } from '../src/modules/purchasing/purchase-receptions/infrastructure/datasources/postgres-purchase-payables.js';
import { PostgresPurchaseReceptionCancellations } from '../src/modules/purchasing/purchase-receptions/infrastructure/datasources/postgres-purchase-reception-cancellations.js';
import { PostgresPurchaseReceptionWrites } from '../src/modules/purchasing/purchase-receptions/infrastructure/datasources/postgres-purchase-reception-writes.js';
import * as salesStock from '../src/modules/sales/orders/infrastructure/datasources/sales-order-inventory-stock.js';
import * as postgres from '../src/shared/infrastructure/database/postgres-pool.js';
import type { PostgresConnectionFactory } from '../src/shared/infrastructure/database/postgres-pool.js';

function connectionTo(db: PGlite): PostgresConnectionFactory {
  return async () => ({
    async query<T extends object>(sql: string, values?: unknown[]) {
      if (values) return db.query<T>(sql, values);
      const results = await db.exec(sql);
      return { rows: (results.at(-1)?.rows ?? []) as T[] };
    },
    release() {},
  });
}

function localReceipts(connect: PostgresConnectionFactory) {
  const actor = { companyId: 1, userId: 3 };
  const fiscal = { fiscalWindow: async () => ({ fiscalStart: '2025-01-01', fiscalEnd: '2025-12-31' }) };
  const legacyVersion = '1'.repeat(64);
  const order: PurchaseOrderProps = {
    id: 55, number: 'OC12345', supplierOrderNumber: '', documentKind: 'order', status: '',
    supplier: { id: 9, code: '000009', name: 'Proveedor' },
    received: { quantity: 0, pieces: 0 }, branch: 0, department: '', warehouse: '01',
    dates: { orderedAt: '2025-12-01', from: null, dueAt: null }, initial: false,
    taxPercentage: 16, discountPercentages: [0, 0, 0], otherLabel: '', classifications: [],
    totals: { ordered: 4, fulfilled: 0, remaining: 4, assigned: 4, subtotal: 200, discount: 0,
      exciseTax: 0, freight: 0, insurance: 0, other: 0, tax: 32, total: 232 },
    lines: [{ id: 101, productId: 7, productCode: 'A', description: 'Producto A',
      ordered: 4, fulfilled: 0, remaining: 4, assigned: 4, confirmed: true, factor: 1, unit: 'PZ',
      branch: 0, classCode: '', price: 50, discount: 0, currencyId: 1, currencyName: 'MXN',
      observations: '', piecesAssignment: '', supplierProductCode: '' }],
  };
  const edits = new PostgresPurchaseOrderEdits(connect, () => true);
  const receipts = new PostgresPurchaseReceptionWrites(edits, connect, { layers: async () => [] });
  const cancel = new CancelPurchaseReception(new PostgresPurchaseReceptionCancellations(edits, connect, () => true), {
    cancellationOrder: async () => {
      const [snapshot] = await edits.find([order.id]);
      return snapshot ? {
        order: PurchaseOrder.create(order).withEditedLines(snapshot, true).toPrimitives(), revision: snapshot.revision,
        legacyVersion, amountInWords: null, supplierRevision: 0, stale: false,
      } : null;
    },
    inventory: async () => new Map([[7, { onHand: 0, assigned: 0 }]]),
  }, fiscal);
  const policy = { receiveAssigned: true, supplierTolerancePercent: 10, canRetireCompletedOrder: false };
  const requestedLines = [{ orderLineId: 101, quantity: 2 }];
  const receive = (
    current: PurchaseOrderProps, revision: number, receivedAt: string, requestKey: string,
    pepsLayer?: PurchaseReceptionPosting['lines'][number]['pepsLayer'],
  ) => {
    const { id: orderLineId, price } = current.lines[0]!;
    const lines = [{ orderLineId, quantity: 2 }];
    const subtotal = 2 * price;
    const tax = Number((subtotal * 0.16).toFixed(2));
    const total = subtotal + tax;
    const posting: PurchaseReceptionPosting = {
      document: { orderNumber: current.number, supplierReference: 'FACT-1', supplier: current.supplier, department: '', warehouse: '01',
        branch: 0, status: '', cancelled: false, dates: { receivedAt, dueAt: receivedAt, orderedAt: current.dates.orderedAt },
        delayDays: 0, classifications: [], discountPercentages: [],
        totals: { units: 2, pieces: 0, subtotal, discount: 0, freight: 0, insurance: 0, other: 0,
          otherLabel: '', exciseTax: 0, taxPercentage: 16, tax, withholdingTax: 0, total, balance: total } },
      movement: { date: receivedAt, reference: current.number, reference2: 'FACT-1', warehouse: '01', supplierCode: current.supplier.code,
        customerCode: '', customerName: '', type: 'RA', status: 0, company: 1, inventoryFlag: 1, billingFlag: 2 },
      lines: [{ orderLineId, ...(pepsLayer ? { pepsLayer } : {}), reception: { productId: 7, productCode: 'A', description: 'Producto A', quantity: 2,
        invoicedQuantity: 2, unit: 'PZ', price, grossPrice: price, discount: 0, amount: subtotal,
        pieces: '', costCenter: 0, branch: 0, lotId: 0, inventoryCreatedAt: null },
      movement: { productId: 7, productCode: 'A', description: 'Producto A', quantity: 2, unit: 'PZ', cost: price,
        pieces: 0, piecesText: '', warehouse: '01', type: 'RA', lotId: 0 } }],
      payable: { amount: total, currencyId: 1, exchangeRate: 1, dueAt: receivedAt },
      accounting: { type: '3', lines: [
        { account: '1150', department: '', debit: subtotal, credit: 0 },
        { account: '1119', department: '', debit: tax, credit: 0 },
        { account: '2005', department: '', debit: 0, credit: total },
      ] },
    };
    return receipts.commit({ actor, posting, fingerprint: '2'.repeat(64),
      context: { order: current, revision, legacyVersion, policy, defaults: { receivedAt, warehouse: '01' }, warehouses: [], reason: null },
      effect: applyPurchaseOrderReceipt(current, lines, policy),
      input: { requestKey, revision, legacyVersion, receivedAt, warehouse: '01', supplierReference: 'FACT-1', lines },
    });
  };
  return { actor, order, edits, cancel, receive, policy, requestedLines };
}

it('reopens an older RW without changing the other receipt or restoring purchase allocations', async () => {
  const db = new PGlite();
  const connect = connectionTo(db);
  const { actor, order, edits, cancel, receive, policy, requestedLines } = localReceipts(connect);
  try {
    const first = await receive(order, 0, '2025-12-02', '302385d4-1e07-4673-ba18-b5d5053455e0');
    const afterFirst = applyPurchaseOrderReceipt(order, requestedLines, policy).order;
    const second = await receive(afterFirst, 1, '2025-12-03', '2f2bbef0-7ad1-4705-9a99-9b442653ead2');
    const id = first.reception.id;
    const input = { requestKey: 'cf117c90-b018-4f78-819d-16e94a1d2751', date: '2025-12-04', reason: 'Error de captura', confirmed: true as const };
    expect(await cancel.prepare(1, id)).toMatchObject({ canWrite: true, policyNumber: '3W00000001', amount: 116 });
    expect((await db.query("SELECT to_regclass('tuvansa.purchase_reception_cancellations') AS present")).rows).toEqual([{ present: null }]);
    await db.exec(`CREATE TABLE tuvansa.sales_remission_inventory(product_id bigint,warehouse text,quantity numeric(18,3));
      INSERT INTO tuvansa.sales_remission_inventory VALUES (7,'01',-3)`);
    expect(await cancel.prepare(1, id)).toMatchObject({ canWrite: false, reason: expect.stringContaining('existencia libre') });
    await expect(cancel.save(actor, id, input)).rejects.toMatchObject({ code: 'PURCHASE_RECEPTION_CANCELLATION_STOCK_INSUFFICIENT' });
    expect((await edits.find([order.id]))[0]).toMatchObject({ revision: 2, totals: { fulfilled: 4, remaining: 0, assigned: 0 } });
    await db.exec('DELETE FROM tuvansa.sales_remission_inventory');

    const cancelled = await cancel.save(actor, id, input);
    expect(cancelled).toEqual({ id: 7940000000000, policyNumber: '3KR00000001', date: input.date, reason: input.reason });
    expect(await cancel.save(actor, id, input)).toEqual(cancelled);
    expect(await cancel.prepare(1, id)).toMatchObject({ canWrite: false, alreadyRecorded: cancelled });
    expect((await edits.find([order.id]))[0]).toMatchObject({ revision: 3,
      totals: { fulfilled: 2, remaining: 2, assigned: 0 }, receiving: { received: { quantity: 100, pieces: 2 } } });
    const { rows: audit } = await db.query('SELECT movement,accounting FROM tuvansa.purchase_reception_cancellations');
    expect(audit).toMatchObject([{ movement: { header: { type: 'K', document: 'KW00000001', reference: first.reception.number },
      lines: [{ quantity: -2, type: 'K' }], totals: { quantity: -2, cost: -100 } },
    accounting: { lines: [{ debit: 0, credit: 100 }, { debit: 0, credit: 16 }, { debit: 116, credit: 0 }] } }]);
    const sql = await localPurchasePayablesSql(await connect());
    expect((await db.query(`SELECT id::float8,principal::float8,cancelled FROM (${sql}) t ORDER BY id`)).rows)
      .toEqual([{ id, principal: 116, cancelled: true }, { id: second.reception.id, principal: 116, cancelled: false }]);
    expect((await db.query('SELECT quantity::float8 AS quantity FROM tuvansa.purchase_reception_cancellation_inventory')).rows).toEqual([{ quantity: -2 }]);
    expect((await db.query('SELECT sum(quantity)::float8 AS quantity FROM tuvansa.purchase_reception_inventory')).rows).toEqual([{ quantity: 4 }]);
  } finally { await db.close(); }
}, 15000);

it('cancels a layered RW only after its exact PEPS lot is fully restored', async () => {
  const db = new PGlite();
  const connect = connectionTo(db);
  const inventoryConnection = vi.spyOn(postgres, 'connectPostgres').mockImplementation(connect);
  const inventoryConfiguration = vi.spyOn(postgres, 'postgresConfigured').mockReturnValue(true);
  const openingStock = vi.spyOn(salesStock, 'readLegacySaleStock').mockResolvedValue(new Map());
  const { actor, order, edits, cancel, receive } = localReceipts(connect);
  const productId = 7;
  const costBasis = { openingStock: 0, average: 0, last: 0, adValorem: 0 };
  const secondOrder = { ...order, id: 56, number: 'OC12346',
    lines: [{ ...order.lines[0]!, id: 102, price: 80 }],
    totals: { ...order.totals, subtotal: 320, tax: 51.2, total: 371.2 },
  };
  const inventory = new PostgresInventoryAdjustmentsDataSource({
    capture: async () => ({ reason: null, defaultDate: '2025-12-04', defaultWarehouse: '01', automaticPeps: true,
      types: [{ code: 'SI', name: 'Salida', sign: -1 }, { code: 'TR', name: 'Traspaso', sign: 0 }],
      warehouses: [{ code: '01', name: 'México' }, { code: '12', name: 'Resguardo' }] }),
    products: async () => new Map([[productId, {
      id: productId, code: 'A', description: 'Producto A', unit: 'PZ', cost: 0, transferCost: 0, layerCost: 0, adValorem: 0,
      active: true, simple: false, peps: true, legacyOnHand: 0, legacyAssigned: 0,
    }]]),
    layers: async () => [],
    documentExists: async () => false,
  });
  const originalLayer = { date: '2025-11-25', customsEntry: '123456789', customsOffice: '240' };
  const nextLayer = { date: '2025-11-26', customsEntry: '', customsOffice: '' };
  const firstPosting = { ...originalLayer, costBasis };
  const readLayers = async () => currentAdjustmentLayers(await connect(), [productId], []);
  const readCost = async () => (await inventoryPepsCostsOn(await connect(), [productId])).get(productId)?.effective;
  const originalRequest = crypto.randomUUID();
  const cancellation = { requestKey: crypto.randomUUID(), date: '2025-12-05', reason: 'Error de captura PEPS', confirmed: true as const };

  try {
    const first = await receive(order, 0, '2025-12-02', originalRequest, firstPosting);
    expect(await receive(order, 0, '2025-12-02', originalRequest, firstPosting)).toEqual(first);
    expect(await readCost()).toEqual({ average: 50, last: 50, adValorem: 0 });
    const second = await receive(secondOrder, 0, '2025-12-03', crypto.randomUUID(), { ...nextLayer, costBasis });
    expect(await readCost()).toEqual({ average: 65, last: 80, adValorem: 0 });
    const lotId = first.reception.lines[0]!.lotId;
    const otherLotId = second.reception.lines[0]!.lotId;
    expect(lotId).toBeGreaterThan(0);
    expect(otherLotId).toBeGreaterThan(0);
    expect(otherLotId).not.toBe(lotId);
    expect(await readLayers()).toMatchObject([
      { ...originalLayer, id: lotId, document: first.reception.number, initial: 2, available: 2, layerOrder: 1, cost: 50, adValorem: 0 },
      { ...nextLayer, id: otherLotId, document: second.reception.number, initial: 2, available: 2, layerOrder: 2, cost: 80, adValorem: 0 },
    ]);
    const beforeTransfer = await readLayers();
    const transfer = await inventory.create({
      requestKey: crypto.randomUUID(), type: 'TR', date: '2025-12-04', warehouse: '01', destinationWarehouse: '12',
      lines: [{ productId, quantity: 1 }],
    });
    expect(transfer.lines).toMatchObject([
      { warehouse: '01', quantity: -1, cost: 65, lotId: 0 },
      { warehouse: '12', quantity: 1, cost: 65, lotId: 0 },
    ]);
    await inventory.cancel(transfer.header.id);
    expect(await readLayers()).toEqual(beforeTransfer);
    expect(await readCost()).toEqual({ average: 65, last: 80, adValorem: 0 });
    expect(await cancel.prepare(1, first.reception.id)).toMatchObject({ canWrite: true, amount: 116 });
    const exit = await inventory.create({ requestKey: crypto.randomUUID(), type: 'SI', date: '2025-12-04', warehouse: '01',
      lines: [{ productId, quantity: 2 }] });
    expect(exit.lines).toMatchObject([{ lotId, quantity: -2, cost: 65 }]);
    expect(await readLayers()).toMatchObject([
      { id: lotId, initial: 2, available: 0, layerOrder: inactivePepsOrder },
      { id: otherLotId, initial: 2, available: 2, layerOrder: 2 },
    ]);
    expect(await cancel.prepare(1, first.reception.id)).toMatchObject({ canWrite: false, reason: expect.stringContaining('ya se utilizó') });
    await expect(cancel.save(actor, first.reception.id, cancellation))
      .rejects.toMatchObject({ code: 'PURCHASE_RECEPTION_CANCELLATION_LAYER_INSUFFICIENT' });
    expect((await edits.find([order.id]))[0]).toMatchObject({ revision: 1, totals: { fulfilled: 2, remaining: 2, assigned: 2 } });
    expect((await db.query('SELECT id FROM tuvansa.purchase_reception_cancellations')).rows).toEqual([]);

    await inventory.cancel(exit.header.id);
    await inventory.cancel(exit.header.id);
    expect(await readLayers()).toMatchObject([
      { id: lotId, initial: 2, available: 2, layerOrder: 3 },
      { id: otherLotId, initial: 2, available: 2, layerOrder: 2 },
    ]);
    expect(await cancel.prepare(1, first.reception.id)).toMatchObject({ canWrite: true });
    const cancelled = await cancel.save(actor, first.reception.id, cancellation);
    expect(await cancel.save(actor, first.reception.id, cancellation)).toEqual(cancelled);
    expect(await cancel.prepare(1, first.reception.id)).toMatchObject({ canWrite: false, alreadyRecorded: cancelled });
    expect(await readCost()).toEqual({ average: 65, last: 80, adValorem: 0 });
    expect(await readLayers()).toMatchObject([
      { ...originalLayer, id: lotId, initial: 0, available: 0, layerOrder: 3 },
      { ...nextLayer, id: otherLotId, initial: 2, available: 2, layerOrder: 2 },
    ]);
    expect((await edits.find([order.id]))[0]).toMatchObject({ revision: 2,
      totals: { fulfilled: 0, remaining: 4, assigned: 2 }, receiving: { received: { quantity: 0, pieces: 0 } } });
    expect((await db.query('SELECT movement,accounting FROM tuvansa.purchase_reception_cancellations')).rows).toMatchObject([
      { movement: { header: { type: 'K', reference: first.reception.number }, lines: [{ lotId, quantity: -2, cost: 50 }] },
        accounting: { lines: [{ debit: 0, credit: 100 }, { debit: 0, credit: 16 }, { debit: 116, credit: 0 }] } },
    ]);
    const payables = await localPurchasePayablesSql(await connect());
    expect((await db.query(`SELECT id::float8,cancelled FROM (${payables}) t ORDER BY id`)).rows).toEqual([
      { id: first.reception.id, cancelled: true }, { id: second.reception.id, cancelled: false },
    ]);
    const nextExit = await inventory.create({ requestKey: crypto.randomUUID(), type: 'SI', date: '2025-12-06', warehouse: '01',
      lines: [{ productId, quantity: 1 }] });
    expect(nextExit.lines).toMatchObject([{ lotId: otherLotId, quantity: -1, cost: 65 }]);
  } finally {
    inventoryConnection.mockRestore();
    inventoryConfiguration.mockRestore();
    openingStock.mockRestore();
    await db.close();
  }
}, 20000);

it('records a historical RA without a receipt copy and rejects a native change before committing', async () => {
  const db = new PGlite();
  const connect = connectionTo(db);
  const date = '2025-02-08';
  const supplier = { id: 3523, code: '003523', name: 'Proveedor' };
  const orderNumber = 'OA05036';
  const orderId = 176729;
  const lineId = 687908;
  const productId = 62752;
  const receiptId = 343646;
  const product = { productId, productCode: 'PZ-1', description: 'Producto' };
  const received = { quantity: 3495.2, pieces: 9 };
  const order: PurchaseOrderProps = {
    id: orderId, number: orderNumber, supplierOrderNumber: '', supplier, documentKind: 'order', status: 'SURT',
    branch: 0, department: '', warehouse: '01', received, dates: { orderedAt: date, from: null, dueAt: null }, initial: false,
    taxPercentage: 16, discountPercentages: [0, 0, 0], otherLabel: '', classifications: [],
    totals: { ordered: 12, fulfilled: 9, remaining: 3, assigned: 2, subtotal: 1746.6, discount: 0, exciseTax: 0,
      freight: 0, insurance: 0, other: 0, tax: 279.46, total: 2026.06 },
    lines: [{ ...product, id: lineId, ordered: 12, fulfilled: 9, remaining: 3, assigned: 2, confirmed: true, factor: 1, unit: 'PZ',
      branch: 0, classCode: '', price: 145.55, discount: 0, currencyId: 1, currencyName: 'MXN', observations: '',
      piecesAssignment: '', supplierProductCode: '' }],
  };
  const source: ReceiptCancellationSource = {
    id: receiptId, orderId, orderNumber, alreadyRecorded: null, orderRetired: false, paymentActive: false, lastReversalDate: null,
    historical: { version: 'stable', blockedReason: null },
    orderLineEffects: [{ orderLineId: lineId, productId, baseQuantity: 6, factor: 1, netAmount: 0 }],
    receipt: {
      id: receiptId, number: 'RA09214', supplier, orderNumber, supplierReference: 'FACTURA', department: '01', warehouse: '01',
      branch: 0, status: '', cancelled: false, dates: { receivedAt: date, dueAt: date, orderedAt: date },
      delayDays: 0, classifications: [], discountPercentages: [],
      totals: { units: 6, pieces: 6, subtotal: 873.3, discount: 0, freight: 0, insurance: 0, other: 0,
        otherLabel: '', exciseTax: 0, taxPercentage: 16, tax: 139.73, withholdingTax: 0, total: 1013.03, balance: 1013.03 },
      lines: [{ ...product, id: 612907, unit: 'PZ', quantity: 6, invoicedQuantity: 6, price: 145.55, grossPrice: 145.55,
        discount: 0, amount: 873.3, pieces: '', costCenter: 1, branch: 0, lotId: 0, inventoryCreatedAt: null }],
    },
    movement: {
      header: { id: receiptId, document: 'RA09214', date, reference: orderNumber, reference2: 'FACTURA',
        warehouse: '01', supplierCode: supplier.code, customerCode: '', customerName: '', type: 'RA', status: 0,
        company: 1, userId: 0, inventoryFlag: 1, billingFlag: 2 },
      lines: [{ ...product, id: 612907, quantity: 6, unit: 'PZ', cost: 145.55, pieces: 0, piecesText: '',
        warehouse: '01', type: 'RA', lotId: 0, userId: 0 }],
      totals: { quantity: 6, cost: 873.3 },
    },
    payable: { amount: 1013.03, currencyId: 1, exchangeRate: 1, dueAt: date },
    accounting: { type: '3', number: '312502-0107', lines: [
      { account: '1115001', department: '1', debit: 873.3, credit: 0 },
      { account: '1119001', department: '0', debit: 139.73, credit: 0 },
      { account: '2001001', department: '1', debit: 0, credit: 1013.03 },
    ] },
  };
  const inventory = async () => new Map([[productId, { onHand: 51, assigned: 0 }]]);
  const edits = new PostgresPurchaseOrderEdits(connect, () => true);
  let beforeCommitChange = false;
  let reads = 0;
  const historical = {
    read: async () => beforeCommitChange && ++reads === 2
      ? { ...source, historical: { version: 'changed', blockedReason: null } } : source,
    inventory,
  };
  const service = new CancelPurchaseReception(new PostgresPurchaseReceptionCancellations(edits, connect, () => true, historical), {
    cancellationOrder: async () => ({ order, revision: 0, legacyVersion: '2'.repeat(64), supplierRevision: 0, amountInWords: null, stale: false }),
    inventory,
  }, { fiscalWindow: async () => ({ fiscalStart: '2025-01-01', fiscalEnd: '2025-12-31' }) });
  const actor = { companyId: 1, userId: 0 };
  const input = { requestKey: 'a7117c90-b018-4f78-819d-16e94a1d2751', date, reason: 'Prueba RA parcial', confirmed: true as const };

  try {
    expect(await service.prepare(1, receiptId)).toMatchObject({ canWrite: true, policyNumber: '312502-0107' });
    expect((await db.query("SELECT to_regclass('tuvansa.purchase_receptions') AS present")).rows).toEqual([{ present: null }]);
    beforeCommitChange = true;
    await expect(service.save(actor, receiptId, input)).rejects.toMatchObject({ code: 'PURCHASE_RECEPTION_SOURCE_CHANGED' });
    expect(await edits.find([orderId])).toEqual([]);
    beforeCommitChange = false;
    const saved = await service.save(actor, receiptId, input);
    expect(await service.save(actor, receiptId, { ...input, requestKey: input.requestKey.toUpperCase() })).toEqual(saved);
    expect(await service.prepare(1, receiptId)).toMatchObject({ canWrite: false, alreadyRecorded: saved });
    expect((await edits.find([orderId]))[0]).toMatchObject({
      revision: 1, receiving: { received: { pieces: 3, quantity: 3495.2 } },
      lines: [{ id: lineId, assigned: 2, fulfilled: 3, remaining: 9 }],
    });
    expect(await historicalReceptionCancellationsOn(await connect(), { supplierIds: [supplier.id] }))
      .toMatchObject([{ receiptId, amount: 1013.03, result: saved }]);
    expect((await db.query('SELECT * FROM tuvansa.purchase_receptions')).rows).toEqual([]);
    expect((await db.query('SELECT quantity::float8 FROM tuvansa.purchase_reception_cancellation_inventory')).rows).toEqual([{ quantity: -6 }]);
  } finally { await db.close(); }
}, 15000);
