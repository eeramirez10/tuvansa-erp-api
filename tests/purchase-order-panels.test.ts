import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LegacyMysqlPurchaseOrdersDataSource } from '../src/modules/purchasing/purchase-orders/infrastructure/datasources/legacy-mysql-purchase-orders-data-source.js';

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('../src/shared/infrastructure/database/legacy-mysql-pool.js', () => ({ legacyMysqlPool: { execute } }));

const dataSource = new LegacyMysqlPurchaseOrdersDataSource();
const order = { id: 42, number: 'O000042' };

beforeEach(() => {
  execute.mockReset();
  execute.mockResolvedValueOnce([[order]]);
});

describe('purchase order action reads', () => {
  it('groups CT by root and aggregates Pedido, Surtido and Resta in configured size order', async () => {
    execute
      .mockResolvedValueOnce([[
        { root: 'ROOT', description: 'Producto', color: 'A', size: 'M', ordered: 10, fulfilled: 4 },
        { root: 'ROOT', description: 'Producto', color: 'A', size: 'M', ordered: 3, fulfilled: 1 },
        { root: 'ROOT', description: 'Producto', color: 'A', size: 'S', ordered: 8, fulfilled: 0 },
        { root: 'ROOT', description: 'Producto', color: 'B', size: 'X', ordered: 2, fulfilled: 0 },
      ]])
      .mockResolvedValueOnce([[{ root: 'ROOT', UTALLA11: 'S', UTALLA12: 'M' }]]);

    const panel = await dataSource.getPanel(order.id, 'ct');
    expect(panel?.items).toEqual([{
      root: 'ROOT', description: 'Producto', ordered: 23, fulfilled: 5, remaining: 18, sizes: ['S', 'M'],
      colors: [{ color: 'A', ordered: [8, 13], fulfilled: [0, 5], remaining: [8, 8] }],
    }]);
    expect(panel?.summary?.totals).toEqual({ ordered: 23, fulfilled: 5, remaining: 18 });
    expect(execute).toHaveBeenNthCalledWith(2, expect.stringContaining('FPLIN.PESEQ = ?'), [order.id]);
    expect(execute).toHaveBeenNthCalledWith(3, expect.stringContaining('FUNIDAD.USEQ = FINV.USEQ'), ['ROOT']);
  });

  it('loads Piezas by its purchase document and sums the quantities without multiplying by pieces', async () => {
    const items = [
      { id: 1, document: order.number, pieces: 2, quantity: 3.5 },
      { id: 2, document: order.number, pieces: 1, quantity: 7 },
    ];
    execute.mockResolvedValueOnce([items]);

    const panel = await dataSource.getPanel(order.id, 'pieces');
    expect(panel?.items).toEqual(items);
    expect(panel?.summary?.totalQuantity).toBe(10.5);
    expect(execute).toHaveBeenNthCalledWith(2, expect.stringContaining('CAJFACTURA = ?'), [order.number]);
  });
});
