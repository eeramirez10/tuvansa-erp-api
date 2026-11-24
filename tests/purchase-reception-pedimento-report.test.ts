import { expect, it, vi } from 'vitest';
import { PurchaseReception } from '../src/modules/purchasing/purchase-receptions/domain/entities/purchase-reception.js';
import { MysqlPurchaseReceptionPedimentoReport } from '../src/modules/purchasing/purchase-receptions/infrastructure/datasources/mysql-purchase-reception-pedimento-report.js';
import { legacyMysqlPool } from '../src/shared/infrastructure/database/legacy-mysql-pool.js';

it('applies the native expense and invoiced quantity formulas to the ordinary pedimento report', async () => {
  const receipt = PurchaseReception.create({
    id: 341534, number: 'RA09154', orderNumber: 'OA05035', supplierReference: '', supplier: { id: 1, code: 'P001', name: 'Proveedor' },
    department: '01', warehouse: '01', branch: 0, status: '', cancelled: false, delayDays: 0,
    dates: { receivedAt: '2025-01-14', dueAt: null, orderedAt: null }, classifications: [], discountPercentages: [],
    totals: { units: 8, pieces: 0, subtotal: 305, discount: 5, freight: 0, insurance: 0, other: 0, otherLabel: '',
      exciseTax: 0, taxPercentage: 0, tax: 0, withholdingTax: 0, total: 300, balance: 300 },
    lines: [{
      id: 1, productId: 2, productCode: 'ART01', description: 'Artículo', quantity: 8, invoicedQuantity: 6, unit: 'PZ',
      price: 50, grossPrice: 60, discount: 0, amount: 300, pieces: '', costCenter: 0, branch: 0, lotId: 0, inventoryCreatedAt: null,
    }],
  });
  const pool = vi.spyOn(legacyMysqlPool, 'execute')
    .mockResolvedValueOnce([[{
      number: '254316005002389', date: '2025-01-14', customsOffice: '430', incrementables: 20, PMTFLETE1: 120,
      PMTPRVFLETE1: ' P002 ', PMTIVAFLETE1: 19.2, PMTAGENTE2: 20, PMTIVAAGENTE2: 3.2, PMTPASIVOS: 10,
    }], []])
    .mockResolvedValueOnce([[{ exchangeRate: 20, volume: 9, useVolume: 0 }], []])
    .mockResolvedValueOnce([[{ id: 2, tariffPercent: 5, piecesPerBox: 10, unitVolume: 2 }], []]);

  try {
    const report = await new MysqlPurchaseReceptionPedimentoReport({ findById: async () => receipt }).execute(341534);
    expect(report.pedimento).toMatchObject({ number: '254316005002389', customsOffice: '430' });
    expect(report.expenses).toHaveLength(7);
    expect(report.expenses).toContainEqual({ slot: 'FLETE1', supplierCode: 'P002', amount: 120, vat: 19.2 });
    expect(report.expenses).toContainEqual({ slot: 'PASIVOS', supplierCode: '', amount: 10, vat: null });
    expect(report.totals).toEqual({ expenses: 150, vat: 22.4, expensePercentage: 50 });
    expect(report.lines).toEqual([{
      code: 'ART01', tariffPercent: 5, convertedPrice: 3, grossPrice: 60, quantity: 6,
      piecesPerBox: 10, unitVolume: 2, receivedVolume: 300, proration: 100, amount: 15,
    }]);
    expect(pool).toHaveBeenCalledWith(expect.stringContaining('p.PMTODOC = receipt.DNUM'), [341534]);
  } finally {
    pool.mockRestore();
  }
});
