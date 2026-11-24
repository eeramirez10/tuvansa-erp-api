import { afterEach, describe, expect, it, vi } from 'vitest';
import { Supplier } from '../src/modules/accounts-payable/suppliers/domain/entities/supplier.js';
import { newSupplier, blankSupplierCatalog } from '../src/modules/accounts-payable/suppliers/domain/entities/supplier-catalog.js';
import { LegacyMysqlSupplierPanelsDataSource } from '../src/modules/accounts-payable/suppliers/infrastructure/datasources/legacy-mysql-supplier-panels-data-source.js';
import { LegacyMysqlSuppliersDataSource } from '../src/modules/accounts-payable/suppliers/infrastructure/datasources/legacy-mysql-suppliers-data-source.js';
import { SupplierPanelsWithPurchaseReceptionsDataSource } from '../src/modules/accounts-payable/suppliers/infrastructure/datasources/supplier-panels-with-purchase-receptions-data-source.js';
import { SuppliersWithPurchaseReceptionsDataSource } from '../src/modules/accounts-payable/suppliers/infrastructure/datasources/suppliers-with-purchase-receptions-data-source.js';

const { historical, localCharge } = vi.hoisted(() => ({
  historical: {
    receiptId: 410, supplierId: 687, number: 'RA100', supplierReference: 'FACTURA-100', amount: 100,
    result: { id: 7940000000000, date: '2025-12-31', reason: 'Cancelación de prueba', policyNumber: '3KR00000001' },
    userId: 42,
  },
  localCharge: {
    id: 6700000000000, company: 1, number: 'RW00000001', movementType: 'RA', date: '2025-10-01', dueAt: null,
    supplierReference: 'FACTURA-RW', orderNumber: 'OC100', userId: 0, principal: 30, remaining: 20,
    currencyId: 1, exchangeRate: 1, policyNumber: '3RW00000001', policyId: 6700000000000,
    payments: [], days: 0, createdAt: '2025-10-01', cancellation: null,
  },
}));

vi.mock('../src/modules/purchasing/purchase-receptions/infrastructure/datasources/historical-purchase-reception-cancellation-reads.js', () => ({
  readHistoricalReceptionCancellations: async (filter: { supplierIds: number[] }) => filter.supplierIds.includes(historical.supplierId) ? [historical] : [],
}));

vi.mock('../src/modules/purchasing/purchase-receptions/infrastructure/datasources/postgres-purchase-payables.js', async (importOriginal) => ({
  ...await importOriginal<object>(),
  readPurchasePayables: async (_fallback: unknown, read: (client: object, source: string) => Promise<unknown>) => read({
    query: async (sql: string) => {
      if (sql.includes('GROUP BY receipt.supplier_id')) return { rows: [{ supplierId: 687, balance: localCharge.remaining }] };
      if (sql.includes('FROM (fixture) AS receipt')) return { rows: [localCharge] };
      return { rows: [{ available: false }] };
    },
  }, 'fixture'),
}));

vi.mock('../src/modules/accounts-payable/suppliers/infrastructure/datasources/postgres-supplier-catalog-data-source.js', async (importOriginal) => ({
  ...await importOriginal<object>(), supplierCatalogRecord: async () => null,
  PostgresSupplierCatalogDataSource: class { async list() { return []; } },
}));

const supplier = { id: 687, code: '000011', name: 'Proveedor de prueba', currentBalance: 300 };
const initial = newSupplier(supplier.id, { ...blankSupplierCatalog('2001001'), code: supplier.code, name: supplier.name }, '2024-01-01');

class LegacySuppliers extends LegacyMysqlSuppliersDataSource {
  override async findById() { return Supplier.create({ ...initial, totals: { ...initial.totals, currentBalance: supplier.currentBalance } }); }
}

afterEach(() => vi.restoreAllMocks());

describe('CxP de recepción histórica cancelada', () => {
  it('descuenta del encabezado y de ambos totales sólo la cuenta por pagar con el DSEQ cancelado', async () => {
    const remaining = { id: 411, document: historical.number, amount: 40, originalAmount: 50 };
    vi.spyOn(LegacyMysqlSupplierPanelsDataSource.prototype, 'findPanel').mockResolvedValue({
      supplier,
      items: [{ id: String(historical.receiptId), document: historical.number, amount: '100.00', originalAmount: 100 }, remaining],
      summary: { amount: 140, originalAmount: 150 },
    });
    const detail = new SuppliersWithPurchaseReceptionsDataSource(new LegacySuppliers());
    const panel = new SupplierPanelsWithPurchaseReceptionsDataSource();

    expect((await detail.findById(supplier.id))?.toPrimitives().totals.currentBalance).toBe(220);
    expect(await panel.findPanel(supplier.id, 'balance')).toMatchObject({
      supplier: { currentBalance: 220 }, summary: { amount: 60, originalAmount: 80 },
      items: [remaining, { id: localCharge.id, amount: 20, originalAmount: 30 }],
    });
  });

  it('conserva los cargos originales y enlaza el abono K con la póliza nueva', async () => {
    const original = { id: 900, receiptId: '410', document: historical.number, movementType: 'RA', amount: 100,
      company: 0, exchangeRate: 1, currency: 0, accountType: 2 };
    const other = { ...original, id: 901, receiptId: 411, currency: 1 };
    vi.spyOn(LegacyMysqlSupplierPanelsDataSource.prototype, 'findPanel').mockResolvedValue({
      supplier, items: [original, other],
    });
    const panel = new SupplierPanelsWithPurchaseReceptionsDataSource();
    const result = await panel.findPanel(supplier.id, 'movements');
    expect(result?.items.slice(0, 2)).toEqual([original, other]);
    expect(result?.items.slice(2)).toMatchObject([
      { document: localCharge.number, amount: 30 },
      { id: historical.result.id, receiptId: historical.receiptId, document: historical.number, amount: -100,
        movementType: 'K', currency: 0, userId: historical.userId, date: historical.result.date,
        documentReference: historical.supplierReference, policy: historical.result.policyNumber, policyId: historical.result.id },
    ]);
  });
});
