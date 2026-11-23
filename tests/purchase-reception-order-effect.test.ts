import { describe, expect, it, vi } from 'vitest';
import type { PurchaseOrderLine, PurchaseOrderProps } from '../src/modules/purchasing/purchase-orders/domain/entities/purchase-order.js';
import { CreatePurchaseReception } from '../src/modules/purchasing/purchase-receptions/application/use-cases/create-purchase-reception.js';
import type {
  PurchaseReceptionCreateInput, PurchaseReceptionPosting, PurchaseReceptionSaveResult, PurchaseReceptionWriteCommand,
} from '../src/modules/purchasing/purchase-receptions/domain/datasources/purchase-reception-write-data-source.js';
import { applyPurchaseOrderReceipt } from '../src/modules/purchasing/purchase-receptions/domain/entities/purchase-reception-order-effect.js';

const supplier = { id: 1, code: 'PROV', name: 'Proveedor' };
const firstLine: PurchaseOrderLine = {
  id: 101, productId: 7, productCode: 'A', description: 'Producto A',
  ordered: 12, fulfilled: 2, remaining: 10, assigned: 8, confirmed: true, factor: 2, unit: 'PQ',
  branch: 0, classCode: '', price: 100, discount: 10, currencyId: 1, currencyName: 'MXN',
  observations: '', piecesAssignment: '', supplierProductCode: '',
};
const order: PurchaseOrderProps = {
  id: 55, number: 'OW00000055', supplierOrderNumber: '', documentKind: 'order', status: '',
  supplier, received: { quantity: 0, pieces: 2 }, branch: 0, department: '', warehouse: '01',
  dates: { orderedAt: '2026-11-22', from: null, dueAt: null }, initial: false,
  taxPercentage: 0, discountPercentages: [5, 0, 0], otherLabel: '', classifications: [],
  totals: {
    ordered: 16, fulfilled: 2, remaining: 14, assigned: 12, subtotal: 0, discount: 0,
    exciseTax: 0, freight: 0, insurance: 0, other: 0, tax: 0, total: 0,
  },
  lines: [
    firstLine,
    { ...firstLine, id: 102, ordered: 4, fulfilled: 0, remaining: 4, assigned: 4, factor: 0, unit: 'PZ' },
  ],
};
const policy = { receiveAssigned: true, supplierTolerancePercent: 10, canRetireCompletedOrder: false };
const lines = [{ orderLineId: 101, quantity: 2 }];

describe('Surtido de la orden al recibir', () => {
  it('descuenta solo lo recibido del pendiente y de la asignación antes de completar el pedido', () => {
    const partial = applyPurchaseOrderReceipt(order, lines, policy);
    expect(partial.order.received).toEqual({ quantity: 342, pieces: 6 });
    expect(partial.order.status).toBe('SURT');
    expect(partial.stock).toEqual([{ productId: 7, pendingDelta: -4, assigned: 8, assignedDelta: -4 }]);
    expect(partial.complete).toBe(false);

    const final = applyPurchaseOrderReceipt(partial.order, [
      { orderLineId: 101, quantity: 3 }, { orderLineId: 102, quantity: 4 },
    ], policy);
    expect(final.order.totals.remaining).toBe(0);
    expect(final.stock).toEqual([{ productId: 7, pendingDelta: -10, assigned: 0, assignedDelta: -8 }]);
    expect(final.complete).toBe(true);
    expect(final.retireCompletedOrder).toBe(false);
  });

  it('conserva el pendiente de otra partida aunque se reciba de más del mismo producto', () => {
    const extra = applyPurchaseOrderReceipt(order, [{ orderLineId: 101, quantity: 5.6 }], policy);
    expect(extra.stock[0]?.pendingDelta).toBe(-10);
    expect(extra.complete).toBe(false);
    expect(() => applyPurchaseOrderReceipt(order, [{ orderLineId: 101, quantity: 5.601 }], policy))
      .toThrow('excede la tolerancia');
  });
});

describe('Guardado de la recepción', () => {
  const actor = { companyId: 1, userId: 0 };
  const input: PurchaseReceptionCreateInput = {
    requestKey: '368bb677-81fd-45e8-bc66-e60c220c2573', revision: 3, legacyVersion: 'actual',
    receivedAt: '2026-11-23', warehouse: '01', supplierReference: 'FACT123', lines,
  };
  const posting: PurchaseReceptionPosting = {
    document: {
      orderNumber: order.number, supplierReference: input.supplierReference, supplier,
      department: '', warehouse: input.warehouse, branch: 0, status: '', cancelled: false,
      dates: { receivedAt: input.receivedAt, dueAt: null, orderedAt: order.dates.orderedAt },
      delayDays: 0, classifications: [], discountPercentages: [],
      totals: {
        units: 4, pieces: 0, subtotal: 342, discount: 0, freight: 0, insurance: 0, other: 0, otherLabel: '',
        exciseTax: 0, taxPercentage: 0, tax: 0, withholdingTax: 0, total: 342, balance: 342,
      },
    },
    movement: {
      date: input.receivedAt, reference: order.number, reference2: input.supplierReference,
      warehouse: input.warehouse, supplierCode: supplier.code, customerCode: '', customerName: '',
      type: 'RA', status: 0, company: actor.companyId, inventoryFlag: 1, billingFlag: 2,
    },
    lines: [{
      orderLineId: firstLine.id,
      reception: {
        productId: firstLine.productId, productCode: firstLine.productCode, description: firstLine.description,
        quantity: 4, invoicedQuantity: 4, unit: firstLine.unit, price: 85.5, grossPrice: 100, discount: 14.5,
        amount: 342, pieces: '', costCenter: 0, branch: 0, lotId: 0, inventoryCreatedAt: null,
      },
      movement: {
        productId: firstLine.productId, productCode: firstLine.productCode, description: firstLine.description,
        quantity: 4, unit: firstLine.unit, cost: 85.5, pieces: 0, piecesText: '', warehouse: input.warehouse, type: 'RA', lotId: 0,
      },
    }],
    payable: { amount: 342, currencyId: 1, exchangeRate: 1, dueAt: '2026-12-23' },
    accounting: { type: '3', lines: [
      { account: '2001', department: '', debit: 0, credit: 342 },
      { account: '1115', department: '', debit: 342, credit: 0 },
    ] },
  };
  const saved: PurchaseReceptionSaveResult = {
    reception: { ...posting.document, id: 67, number: 'RW00000001', lines: [] },
    orderComplete: false, orderRetired: false,
  };

  it('evita guardados inconsistentes y permite repetir una solicitud de invitado ya confirmada', async () => {
    const context = vi.fn().mockResolvedValue({
      order, revision: input.revision, legacyVersion: input.legacyVersion, policy, warehouses: [{ code: '01', name: 'Central' }],
      defaults: { warehouse: input.warehouse, receivedAt: input.receivedAt }, reason: null,
    });
    const preparePosting = vi.fn().mockResolvedValue(posting);
    const findRequest = vi.fn().mockResolvedValue(null);
    const commit = vi.fn().mockResolvedValue(saved);
    const useCase = new CreatePurchaseReception({ context, posting: preparePosting }, { writable: () => true, findRequest, commit });

    await expect(useCase.save(actor, order.id, { ...input, revision: input.revision - 1 }))
      .rejects.toMatchObject({ code: 'PURCHASE_RECEPTION_ORDER_CHANGED' });

    const first = posting.lines[0]!;
    preparePosting.mockResolvedValueOnce({ ...posting, lines: [{ ...first, movement: { ...first.movement, quantity: 2 } }] });
    await expect(useCase.save(actor, order.id, input)).rejects.toMatchObject({ code: 'PURCHASE_RECEPTION_POSTING_MISMATCH' });
    expect(commit).not.toHaveBeenCalled();

    await expect(useCase.save(actor, order.id, input)).resolves.toEqual(saved);
    const command = commit.mock.calls[0]?.[0] as PurchaseReceptionWriteCommand;
    expect(command.effect.stock).toEqual([{ productId: 7, pendingDelta: -4, assigned: 8, assignedDelta: -4 }]);
    expect(command.posting.lines[0]?.movement.quantity).toBe(4);

    findRequest.mockResolvedValueOnce(saved);
    context.mockResolvedValue(null);
    await expect(useCase.save({ userId: 0, companyId: 1 }, order.id, { ...input, retireCompletedOrder: false })).resolves.toEqual(saved);
    expect(findRequest).toHaveBeenLastCalledWith(1, input.requestKey, command.fingerprint);
    expect(context).toHaveBeenCalledTimes(3);
    expect(commit).toHaveBeenCalledTimes(1);
  });
});
