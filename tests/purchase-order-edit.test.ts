import { describe, expect, it } from 'vitest';
import type {
  PurchaseOrderEditInput, PurchaseOrderEditProduct, PurchaseOrderEditRules,
} from '../src/modules/purchasing/purchase-orders/domain/datasources/purchase-order-edit-data-source.js';
import { buildPurchaseOrderEdit, displayPurchaseOrderEditLines, productEditOptions, stockAfterPurchaseOrderRemoval } from '../src/modules/purchasing/purchase-orders/domain/entities/purchase-order-edit.js';
import type { PurchaseOrderLine, PurchaseOrderProps } from '../src/modules/purchasing/purchase-orders/domain/entities/purchase-order.js';
import { assignPurchaseOrderLines } from '../src/modules/purchasing/purchase-orders/domain/entities/purchase-order-confirmation.js';

const first: PurchaseOrderLine = {
  id: 20, productId: 10, productCode: 'A', description: 'Tubo', ordered: 12, fulfilled: 2, remaining: 10,
  unit: 'CJ', classCode: '', branch: 1, price: 2.5, discount: 0, currencyId: 1, currencyName: 'PESOS',
  confirmed: false, observations: '', assigned: 0, piecesAssignment: '', factor: 6, supplierProductCode: '',
};
const base: PurchaseOrderProps = {
  id: 42, number: 'O000042', documentKind: 'order', supplierOrderNumber: '', supplier: { id: 1, code: 'PR', name: '' },
  status: '', branch: 1, department: '', warehouse: '01', initial: false, classifications: [],
  received: {quantity: 0, pieces: 0}, dates: { orderedAt: null, dueAt: null, from: '2026-11-20' },
  taxPercentage: 16, discountPercentages: [10, 0, 0], otherLabel: '',
  totals: { assigned: 0, ordered: 12, fulfilled: 2, remaining: 10, subtotal: 30, discount: 3, exciseTax: 0,
    freight: 5, insurance: 0, other: 0, tax: 5.12, total: 37.12 },
  lines: [first],
};
const rules: PurchaseOrderEditRules = {
  companyId: 1, activeCompanyId: 1, priceLocked: false, supplierUnits: true, validateSupplier: false, supplierCode: 'PR',
  currencyId: 1, currencyName: 'PESOS', supplierDiscounts: [0, 0],
};
const products: PurchaseOrderEditProduct[] = [
  { id: 10, code: 'A', description: 'Tubo', supplierCode: '', supplierProductCode: '', inactive: false,
    taxable: true, currencyId: 1, currencyName: 'PESOS', cost: 2.5, dollarCost: 0, secondaryUnit: 'CJ',
    units: [{ code: 'PZ', factor: 1 }, { code: 'CJ', factor: 6 }] },
  { id: 11, code: 'B', description: 'Empaque', supplierCode: '', supplierProductCode: '', inactive: false,
    taxable: false, currencyId: 1, currencyName: 'PESOS', cost: 10, dollarCost: 0, secondaryUnit: '', units: [{ code: 'PZ', factor: 1 }] },
];
const draft: PurchaseOrderEditInput = {
  revision: 0, legacyVersion: 'a'.repeat(64), removeZero: false,
  lines: [{ id: 20, productCode: 'A', quantity: 2, price: 15, unit: 'CJ', discount: 0, branch: 1, pieces: '' }],
};

describe('purchase order removal stock', () => {
  it('subtracts legacy pending quantities only and combines lines of the same product', () => {
    const lines = [
      { ...first, ordered: 12, fulfilled: 2 },
      { ...first, ordered: 2.555, fulfilled: 1.2 },
      { ...first, ordered: 1, fulfilled: 2 },
      { ...first, productId: 11, ordered: 2, fulfilled: 2 },
    ];
    expect(stockAfterPurchaseOrderRemoval(lines)).toEqual([
      { productId: first.productId, pending: -11.355, nextReceiptAt: null },
    ]);
    expect(stockAfterPurchaseOrderRemoval([])).toEqual([]);
  });
});

describe('purchase order confirmation', () => {
  it('assigns the signed balance in the storage unit and clears all assignments when reversed', () => {
    const partial = { ...first, assigned: 3, confirmed: true, factor: 6 };
    const oversupplied = { ...first, id: 21, productId: 11, ordered: 2, fulfilled: 3 };
    const update = assignPurchaseOrderLines([partial, oversupplied], [first, oversupplied], 'confirm');
    expect(update?.lines).toMatchObject([
      { id: 20, assigned: 10, ordered: 12, fulfilled: 2, factor: 6, confirmed: true },
      { id: 21, assigned: -1, confirmed: true },
    ]);
    expect(update).toMatchObject({ assigned: 9, marker: '', stock: [{ productId: 10, assigned: 10 }, { productId: 11, assigned: -1 }] });
    expect(assignPurchaseOrderLines(update!.lines, [first, oversupplied], 'confirm')).toBeNull();
    const reversed = assignPurchaseOrderLines(update!.lines, [first, oversupplied], 'unconfirm');
    expect(reversed?.lines.every((line) => line.assigned === 0 && !line.confirmed)).toBe(true);
    expect(reversed?.assigned).toBe(0);
  });
});

describe('purchase order edit rules', () => {
  it('applies the unit factor, preserves received quantities and calculates native taxes and stock deltas', () => {
    expect(displayPurchaseOrderEditLines(base.lines)[0]).toMatchObject({ quantity: 2, price: 15 });
    const added = { id: null, productCode: 'B', quantity: 2, price: 10, unit: 'PZ', discount: 10, branch: 1, pieces: '2 cajas' };
    const result = buildPurchaseOrderEdit(base, base.lines, {
      ...draft, lines: [{ ...draft.lines[0]!, quantity: 3 }, added],
    }, rules, products);
    expect(result?.lines).toMatchObject([
      { id: 20, ordered: 18, fulfilled: 2, remaining: 16, price: 2.5 },
      { id: 0, ordered: 2, remaining: 2, piecesAssignment: '' },
    ]);
    expect(result?.stock).toEqual([
      { productId: 10, pending: 6, nextReceiptAt: null },
      { productId: 11, pending: 2, nextReceiptAt: '2026-11-20' },
    ]);
    expect(result?.totals).toMatchObject({ subtotal: 63, discount: 6.3, tax: 7.28, total: 68.98, ordered: 20, fulfilled: 2 });
    expect(result?.amountInWords).toBe('SESENTA Y OCHO 98/100');
  });

  it('requires an explicit removal and applies the zero prompt to an existing line', () => {
    expect(() => buildPurchaseOrderEdit(base, base.lines, { ...draft, lines: [] }, rules, products)).toThrow('Faltan partidas');
    const zero = { ...draft, lines: [{ ...draft.lines[0]!, quantity: 0 }] };
    expect(buildPurchaseOrderEdit(base, base.lines, zero, rules, products)?.lines).toMatchObject([{ ordered: 0 }]);
    const removed = buildPurchaseOrderEdit(base, base.lines, { ...zero, removeZero: true }, rules, products);
    expect(removed?.lines).toEqual([]);
    expect(removed?.stock[0]?.pending).toBe(-10);
    expect(buildPurchaseOrderEdit(base, base.lines, draft, rules, products)).toBeNull();
  });

  it('rejects a price change when blocked and preserves the stored price when only the unit changes', () => {
    const locked = { ...rules, priceLocked: true };
    expect(() => buildPurchaseOrderEdit(base, base.lines, {
      ...draft, lines: [{ ...draft.lines[0]!, price: 120 }],
    }, locked, products)).toThrow('bloqueados');
    const result = buildPurchaseOrderEdit(base, base.lines, {
      ...draft, lines: [{ ...draft.lines[0]!, unit: 'PZ', quantity: 12, price: 99 }],
    }, locked, products);
    expect(result?.lines[0]).toMatchObject({ unit: 'PZ', ordered: 12, price: 2.5, factor: 1 });
  });

  it('preserves Pzas. at creation and converts the price, IEPS and pending quantity', () => {
    const newOrder = { ...base, lines: [] };
    const input = { ...draft, lines: [{ ...draft.lines[0]!, id: null, pieces: '2 cajas' }] };
    const taxableProduct = { ...products[0]!, exciseTaxPercentage: 10 };
    const result = buildPurchaseOrderEdit(newOrder, [], input, rules, [taxableProduct], { initial: true, supplierTaxType: 0 });
    expect(result?.lines[0]).toMatchObject({ ordered: 12, price: 2.5, piecesAssignment: '2 cajas' });
    expect(result?.totals).toMatchObject({ subtotal: 30, discount: 3, exciseTax: 2.70, tax: 5.55, total: 40.25 });
    expect(result?.stock).toEqual([{ productId: 10, pending: 12, nextReceiptAt: '2026-11-20' }]);
    expect(buildPurchaseOrderEdit(newOrder, [], input, rules, [taxableProduct], { initial: true, supplierTaxType: 2 })?.totals.exciseTax).toBe(0);
  });

  it('reverses supplier discounts on foreign-currency suggested prices for the initial capture', () => {
    const product = { ...products[1]!, currencyId: 2, dollarCost: 18 };
    const supplier = { ...rules, supplierDiscounts: [10, 0] as [number, number] };
    expect(productEditOptions(product, supplier, true).units[0]?.suggestedPrice).toBe(20);
    expect(productEditOptions(product, supplier).units[0]?.suggestedPrice).toBe(18);
  });
});
