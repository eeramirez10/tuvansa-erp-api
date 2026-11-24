import { PGlite } from '@electric-sql/pglite';
import { expect, it, vi } from 'vitest';
import { currentAdjustmentLayers, inactivePepsOrder } from '../src/modules/inventories/movements/infrastructure/datasources/inventory-adjustment-layers.js';
import { PostgresInventoryAdjustmentsDataSource } from '../src/modules/inventories/movements/infrastructure/datasources/postgres-inventory-adjustments.js';
import { inventoryPepsCostsOn } from '../src/modules/inventories/movements/infrastructure/datasources/postgres-inventory-peps-cost.js';
import { purchaseOrderPieceIdStart, type PurchaseOrderPiece } from '../src/modules/purchasing/purchase-orders/domain/datasources/purchase-order-pieces-data-source.js';
import { PurchaseOrder, type PurchaseOrderProps } from '../src/modules/purchasing/purchase-orders/domain/entities/purchase-order.js';
import { LegacyMysqlPurchaseOrderEditDataSource } from '../src/modules/purchasing/purchase-orders/infrastructure/datasources/legacy-mysql-purchase-order-edit-data-source.js';
import { LegacyMysqlPurchaseOrdersDataSource } from '../src/modules/purchasing/purchase-orders/infrastructure/datasources/legacy-mysql-purchase-orders-data-source.js';
import { PostgresPurchaseOrderEdits } from '../src/modules/purchasing/purchase-orders/infrastructure/datasources/postgres-purchase-order-edits.js';
import { CancelPurchaseReception } from '../src/modules/purchasing/purchase-receptions/application/use-cases/cancel-purchase-reception.js';
import { CreatePurchaseReception } from '../src/modules/purchasing/purchase-receptions/application/use-cases/create-purchase-reception.js';
import type { ReceiptCancellationSource } from '../src/modules/purchasing/purchase-receptions/domain/datasources/purchase-reception-cancellation-data-source.js';
import type { NativeReceiptPiece, PurchaseOrderPieceTransferReferences } from '../src/modules/purchasing/purchase-receptions/domain/datasources/purchase-reception-pieces-data-source.js';
import type { PurchaseReceptionPosting, PurchaseReceptionWriteContext } from '../src/modules/purchasing/purchase-receptions/domain/datasources/purchase-reception-write-data-source.js';
import { applyPurchaseOrderReceipt } from '../src/modules/purchasing/purchase-receptions/domain/entities/purchase-reception-order-effect.js';
import { historicalReceptionCancellationsOn } from '../src/modules/purchasing/purchase-receptions/infrastructure/datasources/historical-purchase-reception-cancellation-reads.js';
import { localPurchasePayablesSql } from '../src/modules/purchasing/purchase-receptions/infrastructure/datasources/postgres-purchase-payables.js';
import { MysqlPurchaseReceptionWriteReferences } from '../src/modules/purchasing/purchase-receptions/infrastructure/datasources/mysql-purchase-reception-write-references.js';
import { PostgresPurchaseReceptionCancellations } from '../src/modules/purchasing/purchase-receptions/infrastructure/datasources/postgres-purchase-reception-cancellations.js';
import { PostgresPurchaseReceptionWrites } from '../src/modules/purchasing/purchase-receptions/infrastructure/datasources/postgres-purchase-reception-writes.js';
import { movedPurchasePieceOrigins, purchaseReceptionPieceProducts } from '../src/modules/purchasing/purchase-receptions/infrastructure/datasources/purchase-reception-piece-reads.js';
import * as salesStock from '../src/modules/sales/orders/infrastructure/datasources/sales-order-inventory-stock.js';
import { legacyMysqlPool } from '../src/shared/infrastructure/database/legacy-mysql-pool.js';
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

function localReceipts(connect: PostgresConnectionFactory, pieceReferences?: PurchaseOrderPieceTransferReferences) {
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
  const receipts = new PostgresPurchaseReceptionWrites(edits, connect, { layers: async () => [] }, pieceReferences);
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
  return { actor, order, edits, cancel, receive, receipts, policy, requestedLines };
}

function nativeOrderPiece(fields: Partial<NativeReceiptPiece> = {}): NativeReceiptPiece {
  return {
    id: 501, productId: 8, productCode: 'B', serialNumber: 'NATIVE-501', pieces: 2, quantity: 3.5,
    warehouse: '05', orderNumber: 'PEND-1', reference: 'REF-1', date: '2025-10-01',
    receiptNumber: 'OC12345', invoiceNumber: 'OC12345', customsEntry: '252443012345678',
    importDate: '2025-10-02', customsOffice: '430', notes: 'Serie de origen', ...fields,
  };
}

function webOrderPiece(fields: Partial<PurchaseOrderPiece> = {}): PurchaseOrderPiece {
  return {
    id: 0, productCode: 'A', serial: 'WEB-ORIGEN', pieces: 1, quantity: 4, warehouse: '06',
    document: 'OC12345', receipt: 'OC12345', ...fields,
  };
}

it('traslada las series de la orden en la primera recepción parcial y las retira sólo cuando están sin facturar', async () => {
  const db = new PGlite();
  const connect = connectionTo(db);
  const native = nativeOrderPiece();
  const nativeCandidates = [
    native, nativeOrderPiece({ id: 502, serialNumber: 'SÓLO-FACTURA', receiptNumber: 'OTRO' }),
    nativeOrderPiece({ id: 503, serialNumber: 'SÓLO-RECEPCIÓN', invoiceNumber: 'OTRO' }),
    nativeOrderPiece({ id: 504, serialNumber: 'GRUPO-REEMPLAZADO', productId: 7, productCode: 'A' }),
  ];
  const nativeReferences = {
    orderPieces: vi.fn(async () => nativeCandidates),
    matchingSerials: vi.fn(async (serials: string[]) => nativeCandidates.filter((piece) => serials.includes(piece.serialNumber))),
  };
  const { actor, order, edits, cancel, receive, policy, requestedLines } = localReceipts(connect, nativeReferences);
  order.lines.push({ ...order.lines[0]!, id: 102, productId: 8, productCode: 'B', description: 'Producto B' });
  order.totals = { ...order.totals, ordered: 8, remaining: 8, assigned: 8, subtotal: 400, tax: 64, total: 464 };
  const web = webOrderPiece();
  const notLinked = webOrderPiece({ serial: 'WEB-OTRO', receipt: 'OTRO', quantity: 1 });
  const requestKey = crypto.randomUUID();
  const cancelRequest = { requestKey: crypto.randomUUID(), date: '2025-12-04', reason: 'Entrada equivocada', confirmed: true as const };
  const pieceRows = async () => (await db.query(
    'SELECT id::float8, receipt_id::float8 AS "receiptId", retired, piece FROM tuvansa.purchase_reception_pieces ORDER BY id',
  )).rows;
  try {
    await edits.savePieces({ id: order.id, number: order.number, lines: order.lines, totals: order.totals, amountInWords: null,
      legacyVersion: '1'.repeat(64), revision: 0 }, [{ productCode: 'A', items: [web, notLinked] }]);
    const first = await receive(order, 1, '2025-12-02', requestKey);
    const id = first.reception.id;
    const delivered = { warehouse: '01', date: '2025-12-02', receiptNumber: first.reception.number, invoiceNumber: '', orderNumber: '' };
    expect(first.reception).toMatchObject({ totals: { units: 2, pieces: 0, total: 116 }, lines: [{ productId: 7, quantity: 2, pieces: '' }] });
    expect(await pieceRows()).toMatchObject([
      { id: native.id, receiptId: id, retired: false, piece: { ...native, ...delivered } },
      { id: purchaseOrderPieceIdStart, receiptId: id, retired: false,
        piece: { ...delivered, id: purchaseOrderPieceIdStart, productId: 7, productCode: 'A', serialNumber: web.serial, quantity: 4 } },
    ]);
    expect(await edits.listPieceOverrides({ id: order.id, number: order.number })).toMatchObject([
      { productCode: 'A', items: [{ id: purchaseOrderPieceIdStart + 1, serial: notLinked.serial }] },
    ]);
    expect(await movedPurchasePieceOrigins([native.id, purchaseOrderPieceIdStart, 502], await connect())).toEqual(new Map([
      [native.id, { id: native.id, orderId: order.id, orderNumber: order.number }],
      [purchaseOrderPieceIdStart, { id: purchaseOrderPieceIdStart, orderId: order.id, orderNumber: order.number }],
    ]));
    expect(await purchaseReceptionPieceProducts([7, 8], await connect())).toEqual(new Set());
    expect(await receive(order, 1, '2025-12-02', requestKey)).toEqual(first);
    expect(nativeReferences.orderPieces).toHaveBeenCalledTimes(1);

    // Simulate the invoice binding that /111 checks before canceling the exact receipt.
    await db.query("UPDATE tuvansa.purchase_reception_pieces SET piece=jsonb_set(piece,'{invoiceNumber}',to_jsonb('FA1'::text)) WHERE id=$1", [native.id]);
    await expect(cancel.prepare(1, id)).resolves.toMatchObject({ canWrite: false, reason: expect.stringContaining('factura') });
    await expect(cancel.save(actor, id, cancelRequest)).rejects.toMatchObject({ code: 'PURCHASE_RECEPTION_CANCELLATION_BLOCKED' });
    expect(await pieceRows()).toMatchObject([{ retired: false }, { retired: false }]);
    await db.query("UPDATE tuvansa.purchase_reception_pieces SET piece=jsonb_set(piece,'{invoiceNumber}',to_jsonb(''::text)) WHERE id=$1", [native.id]);
    const cancelled = await cancel.save(actor, id, cancelRequest);
    expect(await cancel.save(actor, id, cancelRequest)).toEqual(cancelled);
    expect(await pieceRows()).toMatchObject([{ id: native.id, receiptId: id, retired: true }, { id: purchaseOrderPieceIdStart, receiptId: id, retired: true }]);

    // A subsequent receipt must skip the retired native source despite the unchanged MySQL record.
    const [snapshot] = await edits.find([order.id]);
    const afterCancel = PurchaseOrder.create(order).withEditedLines(snapshot!, true).toPrimitives();
    const second = await receive(afterCancel, snapshot!.revision, '2025-12-05', crypto.randomUUID());
    expect(second.reception.id).not.toBe(id);
    expect(nativeReferences.orderPieces).toHaveBeenCalledTimes(2);
    expect(await pieceRows()).toHaveLength(2);
    expect((await db.query('SELECT quantity::float8 FROM tuvansa.purchase_reception_inventory ORDER BY receipt_id')).rows)
      .toEqual([{ quantity: 2 }, { quantity: 2 }]);
    expect((await db.query('SELECT quantity::float8 FROM tuvansa.purchase_reception_cancellation_inventory')).rows).toEqual([{ quantity: -2 }]);
    expect(applyPurchaseOrderReceipt(afterCancel, requestedLines, policy).order.lines[0]?.fulfilled).toBe(2);
  } finally { await db.close(); }
}, 15000);

it('revierte la recepción, movimientos y revisión de la orden si una serie de origen está duplicada', async () => {
  const db = new PGlite();
  const connect = connectionTo(db);
  const native = nativeOrderPiece();
  const competing = { id: 741, serialNumber: native.serialNumber };
  const nativeReferences = {
    orderPieces: async () => [native],
    matchingSerials: vi.fn(async () => [native, competing]),
  };
  const { order, edits, receive } = localReceipts(connect, nativeReferences);
  const web = webOrderPiece();
  try {
    await edits.savePieces({ id: order.id, number: order.number, lines: order.lines, totals: order.totals, amountInWords: null,
      legacyVersion: '1'.repeat(64), revision: 0 }, [{ productCode: 'A', items: [web] }]);
    const requestKey = crypto.randomUUID();
    const save = () => receive(order, 1, '2025-12-02', requestKey);
    await expect(save()).rejects.toMatchObject({ code: 'PURCHASE_RECEPTION_PIECE_TRANSFER_CONFLICT' });
    expect((await edits.find([order.id]))[0]).toMatchObject({ revision: 1, totals: { fulfilled: 0, remaining: 4, assigned: 4 } });
    expect(await edits.listPieceOverrides({ id: order.id, number: order.number })).toMatchObject([{ items: [{ serial: web.serial }] }]);
    expect((await db.query(`SELECT (SELECT count(*)::int FROM tuvansa.purchase_receptions) AS receipts,
      (SELECT count(*)::int FROM tuvansa.purchase_reception_inventory) AS inventory,
      (SELECT count(*)::int FROM tuvansa.purchase_order_stock_deltas) AS pending,
      (SELECT count(*)::int FROM tuvansa.purchase_reception_pieces) AS pieces`)).rows)
      .toEqual([{ receipts: 0, inventory: 0, pending: 0, pieces: 0 }]);
    nativeReferences.matchingSerials.mockResolvedValue([native]);
    await expect(save()).resolves.toMatchObject({ reception: { totals: { units: 2, total: 116 } } });
    expect((await db.query('SELECT count(*)::int FROM tuvansa.purchase_reception_pieces')).rows).toEqual([{ count: 2 }]);
  } finally { await db.close(); }
}, 15000);

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

it('registra el pedimento, aplica incrementables al arancel y conserva la trazabilidad al anular', async () => {
  const db = new PGlite();
  const connect = connectionTo(db);
  const inventoryConnection = vi.spyOn(postgres, 'connectPostgres').mockImplementation(connect);
  const inventoryConfiguration = vi.spyOn(postgres, 'postgresConfigured').mockReturnValue(true);
  const bits = new Set([22, 24, 37, 45, 51, 68, 78]);
  const flags = Array.from({ length: 94 }, (_, index) => bits.has(index + 1) ? '1' : '0').join('');
  const native = vi.spyOn(legacyMysqlPool, 'execute').mockImplementation(async (query) => {
    const sql = String(query);
    const row = sql.includes('FROM FCIA C') ? {
      flags, plugs: '---X', noCosts: 0, fiscalStart: '2025-01-01', fiscalEnd: '2025-12-31',
      movement: 'RA', accountMode: 0, policyType: '3', vatRate: 16, vatAccount: '1119',
      terms: 0, supplierAccount: '2005',
    } : sql.includes('FROM FINV') ? {
      id: 7, unit: 'PZ', noLayers: 0, layerProduct: true, controlsPieces: 0, vatCode: 0, tariff: 10,
      openingStock: 0, average: 0, last: 0, adValorem: 0,
      customsEntry: '', customsOffice: '', importDate: null, account: '1150',
    } : undefined;
    if (!row) throw new Error(`Consulta inesperada: ${sql}`);
    return [[row], []] as unknown as Awaited<ReturnType<typeof legacyMysqlPool.execute>>;
  });
  const { actor, order, edits, cancel, receipts, policy, requestedLines } = localReceipts(connect);
  order.discountPercentages = [10, 0, 0];
  const context: PurchaseReceptionWriteContext = {
    order, revision: 0, legacyVersion: '1'.repeat(64), policy, reason: null, pedimentoAvailable: true,
    defaults: { receivedAt: '2025-12-03', warehouse: '01' }, warehouses: [{ code: '01', name: 'México' }],
  };
  const references = new MysqlPurchaseReceptionWriteReferences(
    new LegacyMysqlPurchaseOrderEditDataSource(new LegacyMysqlPurchaseOrdersDataSource()), edits,
  );
  const create = new CreatePurchaseReception({ context: async () => context, posting: references.posting.bind(references) }, receipts);
  const baseInput = {
    requestKey: crypto.randomUUID(), revision: 0, legacyVersion: context.legacyVersion,
    receivedAt: context.defaults.receivedAt, warehouse: '01', supplierReference: 'PEDIMENTO-TEST', lines: requestedLines,
  };
  const pedimento = { number: '250143012345678', date: '2025-01-14', customsOffice: '430', incrementables: 9 };
  try {
    expect(await create.get(1, order.id)).toMatchObject({ canWrite: true, pedimentoAvailable: true });
    await expect(create.save(actor, order.id, baseInput)).rejects.toMatchObject({ code: 'PURCHASE_RECEPTION_POSTING_UNSUPPORTED' });
    const saved = await create.save(actor, order.id, { ...baseInput, pedimento });
    const id = saved.reception.id;
    const lotId = saved.reception.lines[0]!.lotId;
    expect(await create.save(actor, order.id, { ...baseInput, pedimento: { ...pedimento, number: ' ' + pedimento.number } }))
      .toEqual(saved);
    await expect(create.save(actor, order.id, { ...baseInput, pedimento: { ...pedimento, incrementables: 10 } }))
      .rejects.toMatchObject({ code: 'PURCHASE_RECEPTION_REQUEST_CONFLICT' });
    expect(saved.reception).toMatchObject({ pedimento, totals: { subtotal: 100, discount: 10, tax: 14.4, total: 104.4 } });
    const readLayers = async () => currentAdjustmentLayers(await connect(), [7], []);
    const layer = { id: lotId, customsEntry: pedimento.number, customsOffice: '430', date: '2025-01-14', cost: 45, adValorem: 5 };
    expect(await readLayers()).toMatchObject([{ ...layer, initial: 2, available: 2 }]);
    expect((await db.query('SELECT movement,accounting,payable FROM tuvansa.purchase_receptions WHERE id=$1', [id])).rows)
      .toMatchObject([{
        movement: { lines: [{ lotId, customsEntry: pedimento.number, quantity: 2, cost: 50 }], totals: { cost: 100 } },
        payable: { amount: 104.4 }, accounting: { lines: [
          { account: '2005', credit: 104.4 }, { account: '1150', debit: 90 }, { account: '1119', debit: 14.4 },
        ] },
      }]);
    const before = (await inventoryPepsCostsOn(await connect(), [7])).get(7);
    expect(before?.effective).toMatchObject({ average: 45, last: 45, adValorem: 5,
      customs: { customsEntry: pedimento.number, date: pedimento.date, customsOffice: '430' } });
    await cancel.save(actor, id, { requestKey: crypto.randomUUID(), date: '2025-12-04', reason: 'Prueba pedimento', confirmed: true });
    expect(await readLayers()).toMatchObject([{ ...layer, initial: 0, available: 0 }]);
    expect((await inventoryPepsCostsOn(await connect(), [7])).get(7)).toEqual(before);
    expect((await db.query("SELECT result #> '{reception,pedimento}' AS pedimento FROM tuvansa.purchase_receptions WHERE id=$1", [id])).rows)
      .toEqual([{ pedimento }]);
  } finally {
    native.mockRestore();
    inventoryConnection.mockRestore();
    inventoryConfiguration.mockRestore();
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
