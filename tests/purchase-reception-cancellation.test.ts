import { PGlite } from '@electric-sql/pglite';
import { expect, it } from 'vitest';
import { PurchaseOrder, type PurchaseOrderProps } from '../src/modules/purchasing/purchase-orders/domain/entities/purchase-order.js';
import { PostgresPurchaseOrderEdits } from '../src/modules/purchasing/purchase-orders/infrastructure/datasources/postgres-purchase-order-edits.js';
import { CancelPurchaseReception } from '../src/modules/purchasing/purchase-receptions/application/use-cases/cancel-purchase-reception.js';
import type { PurchaseReceptionPosting } from '../src/modules/purchasing/purchase-receptions/domain/datasources/purchase-reception-write-data-source.js';
import { applyPurchaseOrderReceipt } from '../src/modules/purchasing/purchase-receptions/domain/entities/purchase-reception-order-effect.js';
import { localPurchasePayablesSql } from '../src/modules/purchasing/purchase-receptions/infrastructure/datasources/postgres-purchase-payables.js';
import { PostgresPurchaseReceptionCancellations } from '../src/modules/purchasing/purchase-receptions/infrastructure/datasources/postgres-purchase-reception-cancellations.js';
import { PostgresPurchaseReceptionWrites } from '../src/modules/purchasing/purchase-receptions/infrastructure/datasources/postgres-purchase-reception-writes.js';
import type { PostgresConnectionFactory } from '../src/shared/infrastructure/database/postgres-pool.js';

it('reopens an older RW without changing the other receipt or restoring purchase allocations', async () => {
  const db = new PGlite();
  const connect: PostgresConnectionFactory = async () => ({
    async query<T extends object>(sql: string, values?: unknown[]) {
      if (values) return db.query<T>(sql, values);
      const results = await db.exec(sql);
      return { rows: (results.at(-1)?.rows ?? []) as T[] };
    },
    release() {},
  });
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
  const receipts = new PostgresPurchaseReceptionWrites(edits, connect);
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
  const receive = (current: PurchaseOrderProps, revision: number, receivedAt: string, requestKey: string) => {
    const posting: PurchaseReceptionPosting = {
      document: { orderNumber: order.number, supplierReference: 'FACT-1', supplier: order.supplier, department: '', warehouse: '01',
        branch: 0, status: '', cancelled: false, dates: { receivedAt, dueAt: receivedAt, orderedAt: order.dates.orderedAt },
        delayDays: 0, classifications: [], discountPercentages: [],
        totals: { units: 2, pieces: 0, subtotal: 100, discount: 0, freight: 0, insurance: 0, other: 0,
          otherLabel: '', exciseTax: 0, taxPercentage: 16, tax: 16, withholdingTax: 0, total: 116, balance: 116 } },
      movement: { date: receivedAt, reference: order.number, reference2: 'FACT-1', warehouse: '01', supplierCode: order.supplier.code,
        customerCode: '', customerName: '', type: 'RA', status: 0, company: 1, inventoryFlag: 1, billingFlag: 2 },
      lines: [{ orderLineId: 101, reception: { productId: 7, productCode: 'A', description: 'Producto A', quantity: 2,
        invoicedQuantity: 2, unit: 'PZ', price: 50, grossPrice: 50, discount: 0, amount: 100,
        pieces: '', costCenter: 0, branch: 0, lotId: 0, inventoryCreatedAt: null },
      movement: { productId: 7, productCode: 'A', description: 'Producto A', quantity: 2, unit: 'PZ', cost: 50,
        pieces: 0, piecesText: '', warehouse: '01', type: 'RA', lotId: 0 } }],
      payable: { amount: 116, currencyId: 1, exchangeRate: 1, dueAt: receivedAt },
      accounting: { type: '3', lines: [
        { account: '1150', department: '', debit: 100, credit: 0 },
        { account: '1119', department: '', debit: 16, credit: 0 },
        { account: '2005', department: '', debit: 0, credit: 116 },
      ] },
    };
    return receipts.commit({ actor, posting, fingerprint: '2'.repeat(64),
      context: { order: current, revision, legacyVersion, policy, defaults: { receivedAt, warehouse: '01' }, warehouses: [], reason: null },
      effect: applyPurchaseOrderReceipt(current, requestedLines, policy),
      input: { requestKey, revision, legacyVersion, receivedAt, warehouse: '01', supplierReference: 'FACT-1', lines: requestedLines },
    });
  };
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
