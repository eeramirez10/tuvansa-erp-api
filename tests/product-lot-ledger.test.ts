import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { localProductLedger } from '../src/modules/inventories/products/infrastructure/datasources/local-product-ledger.js';
import { ProductPanelsWithPurchaseReceptionsDataSource } from '../src/modules/inventories/products/infrastructure/datasources/product-panels-with-purchase-receptions-data-source.js';
import { legacyMysqlPool } from '../src/shared/infrastructure/database/legacy-mysql-pool.js';

const db = new PGlite();
const product = { id: 47087, code: '004212899', description: 'Producto de prueba' };
const lotId = 81;
const localLotId = 7971000000000;

vi.mock('../src/shared/infrastructure/database/legacy-mysql-pool.js', () => ({
  legacyMysqlPool: { execute: vi.fn() },
}));
vi.mock('../src/shared/infrastructure/database/postgres-pool.js', async (importOriginal) => ({
  ...await importOriginal<object>(),
  connectPostgres: () => Promise.resolve({
    query: <T extends object>(sql: string, values?: unknown[]) => db.query<T>(sql, values),
    release() {},
  }),
  postgresConfigured: () => true,
}));
vi.mock('../src/modules/inventories/movements/infrastructure/datasources/inventory-adjustment-layers.js', async (importOriginal) => ({
  ...await importOriginal<object>(),
  adjustmentLotState: async () => ({
    deltas: new Map([[81, -1]]),
    orders: new Map([[81, 10000]]),
    local: [0, 1].map((index) => ({
      id: 7971000000000 + index, productId: 47087, warehouse: '01', date: '2025-12-29',
      initial: 3, available: 2, cost: 12.5, adValorem: 1, document: `EI00${index}`, layerOrder: index + 2,
      customsEntry: '', customsOffice: '', expiresAt: null, lot: '', number: '', location: '',
    })),
  }),
}));

beforeAll(async () => {
  await db.exec(`
    CREATE SCHEMA tuvansa;
    CREATE TABLE tuvansa.inventory_adjustments(id bigint, movement jsonb);
    CREATE TABLE tuvansa.inventory_adjustment_stock(adjustment_id bigint, product_id bigint);
  `);
  const header = { company: 1, date: '2025-12-29', document: 'SI01' };
  const line = { productId: product.id, warehouse: '01', lotId, type: 'SI' };
  const lines = [
    { ...line, id: 101, quantity: 3 },
    { ...line, id: 102, quantity: 100, lotId: 82 },
    { ...line, id: 103, quantity: 100, warehouse: '02' },
    { ...line, id: 104, quantity: 100, productId: product.id + 1 },
    { ...line, id: 105, quantity: -1 },
  ];
  await db.query('INSERT INTO tuvansa.inventory_adjustments VALUES (1, $1)', [JSON.stringify({ header, lines })]);
  await db.query('INSERT INTO tuvansa.inventory_adjustment_stock VALUES (1, $1)', [product.id]);
});

afterAll(() => db.close());

describe('Auxiliar por lote', () => {
  it('aplica producto, almacén y lote antes de paginar y calcular totales en PostgreSQL', async () => {
    const filters = { lotId, warehouse: '01' };
    const totals = { count: 2, entries: 3, exits: 1, net: 2 };
    const page = await localProductLedger(product.id, filters, 1, async () => 1);
    expect(page).toMatchObject({ items: [{ id: 105, quantity: -1, lotId }], lotTotals: totals });
    const totalsOnly = await localProductLedger(product.id, filters, 0, async () => 0);
    expect(totalsOnly).toMatchObject({ items: [], lotTotals: totals });
  });

  it('combina los totales y pagina desde el último movimiento histórico del lote consultado', async () => {
    const execute = vi.mocked(legacyMysqlPool.execute).mockReset();
    execute.mockResolvedValueOnce([[product], []])
      .mockResolvedValueOnce([[{ count: '1', entries: '2', exits: '0', net: '2' }], []])
      .mockResolvedValueOnce([[], []]);

    const page = await new ProductPanelsWithPurchaseReceptionsDataSource().getPanel(product.id, 'ledger',
      { limit: 1, offset: 2, ledger: { lotId, warehouse: '01' } });

    const [aggregate, movements] = execute.mock.calls.slice(1);
    expect(aggregate).toEqual([expect.stringContaining('AND faxinv.LOSEQ = ?'), [product.id, '01', lotId]]);
    expect(aggregate?.[0]).not.toEqual(expect.stringContaining('LIMIT'));
    expect(movements).toEqual([
      expect.stringContaining('AND faxinv.LOSEQ = ? ORDER BY finv.ISEQ, faxinv.AISEQ LIMIT ? OFFSET ?'),
      [product.id, '01', lotId, 1, 2],
    ]);
    expect(page).toMatchObject({
      items: [{ id: 105, quantity: -1, lotId }],
      lotTotals: { count: 3, entries: 5, exits: 1, net: 4 },
    });
  });

  it('proyecta los saldos de lotes históricos y pagina los nuevos con sus cantidades PEPS', async () => {
    const execute = vi.mocked(legacyMysqlPool.execute).mockReset();
    execute.mockResolvedValueOnce([[product], []])
      .mockResolvedValueOnce([[{ id: lotId, availableQuantity: '2.500', lot: 'HIST' }], []])
      .mockResolvedValueOnce([[product], []])
      .mockResolvedValueOnce([[], []])
      .mockResolvedValueOnce([[{ count: '1' }], []]);
    const panels = new ProductPanelsWithPurchaseReceptionsDataSource();
    const first = await panels.getPanel(product.id, 'lots', { limit: 2, offset: 0 });
    expect(first?.items).toMatchObject([
      { id: lotId, availableQuantity: 1.5, lot: 'HIST' },
      { id: localLotId, availableQuantity: 2, lot: '', warehouse: '01' },
    ]);
    const second = await panels.getPanel(product.id, 'inventory-layers', { limit: 2, offset: 2 });
    expect(second?.items).toMatchObject([
      { id: localLotId + 1, quantity: 2, initialQuantity: 3, document: 'EI001', cost: 12.5, adValoremCost: 1,
        layerKey: '004212899       3' },
    ]);
  });
});
