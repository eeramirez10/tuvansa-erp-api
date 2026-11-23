import { describe, expect, it, vi } from 'vitest';
import { GetProductPanel } from '../src/modules/inventories/products/application/use-cases/get-product-panel.js';
import { SetProductBlockStatus } from '../src/modules/inventories/products/application/use-cases/set-product-block-status.js';
import { LegacyMysqlProductPanelsDataSource } from '../src/modules/inventories/products/infrastructure/datasources/legacy-mysql-product-panels-data-source.js';
import { legacyMysqlPool } from '../src/shared/infrastructure/database/legacy-mysql-pool.js';
import * as purchaseOrderRemovalSource from '../src/shared/infrastructure/datasources/postgres-purchase-order-removals.js';
import { purchaseOrderLineAssignments } from '../src/shared/infrastructure/datasources/postgres-purchase-order-confirmation.js';
import type {
  ProductPanelResult,
  ProductPanelsRepository,
} from '../src/modules/inventories/products/domain/repositories/product-panels-repository.js';

vi.mock('../src/shared/infrastructure/database/legacy-mysql-pool.js', () => ({
  legacyMysqlPool: { execute: vi.fn() },
}));
vi.mock('../src/shared/infrastructure/datasources/postgres-purchase-order-removals.js', async (importOriginal) => ({
  ...await importOriginal<typeof purchaseOrderRemovalSource>(),
  legacyPurchaseOrderRemovals: vi.fn(async () => []),
}));
vi.mock('../src/shared/infrastructure/datasources/postgres-purchase-order-confirmation.js', () => ({
  purchaseOrderLineAssignments: vi.fn(async () => []),
}));

const panel: ProductPanelResult = {
  product: { id: 47087, code: '004212899', description: 'Producto de prueba' },
  key: 'warehouses',
  section: 'actions',
  button: 'Almacenes',
  available: true,
  source: 'mysql',
  items: [{ warehouseCode: '03', quantity: 2 }],
};

describe('Inventarios PT - botones laterales', () => {
  it('pagina el auxiliar en orden de movimiento con la proyección del SQL capturado', async () => {
    const execute = vi.mocked(legacyMysqlPool.execute);
    execute.mockReset();
    const movement = {
      id: 702,
      pieces: 12,
      route: '01',
      ellosReference: 'REF',
      documentUserId: 7,
      documentId: 200,
    };
    execute
      .mockResolvedValueOnce([[panel.product], []])
      .mockResolvedValueOnce([[movement], []]);

    const result = await new LegacyMysqlProductPanelsDataSource().getPanel(
      panel.product.id, 'ledger', { limit: 100, offset: 100 },
    );

    expect(execute).toHaveBeenCalledTimes(2);
    const [query, values] = execute.mock.calls[1]!;
    expect(query).toEqual(expect.stringContaining('LEFT JOIN finv ON faxinv.ISEQ = finv.ISEQ'));
    expect(query).toEqual(expect.stringContaining('WHERE finv.ISEQ = ? AND AIMES = 1 AND DEST = 0 AND DMULTICIA = 1'));
    expect(query).toEqual(expect.stringContaining('ORDER BY finv.ISEQ, faxinv.AISEQ LIMIT ? OFFSET ?'));
    expect(values).toEqual([panel.product.id, 100, 100]);
    expect(result).toMatchObject({ button: 'Auxiliar', source: 'mysql', items: [movement] });
  });

  it('conserva la correspondencia de boton y paginacion', async () => {
    const repository: ProductPanelsRepository = {
      getPanel: async (_productId, key, criteria) => ({
        ...panel,
        key,
        items: [{ offset: criteria.offset, limit: criteria.limit }],
      }),
      setBlocked: async () => null,
    };
    const response = await new GetProductPanel(repository)
      .execute(47087, 'warehouses', 3, 25);
    expect(response.data.button).toBe('Almacenes');
    expect(response.data.items[0]).toEqual({ offset: 50, limit: 25 });
    expect(response.pagination).toEqual({ page: 3, pageSize: 25, returned: 1 });
  });

  it.each([
    { warehouse: '01', openingMovementType: undefined },
    { warehouse: '', openingMovementType: 'R' as const },
  ])('calcula el saldo de almacén antes de paginar y conserva el orden de los filtros ($warehouse)', async ({ warehouse, openingMovementType }) => {
    const execute = vi.mocked(legacyMysqlPool.execute).mockReset();
    execute
      .mockResolvedValueOnce([[panel.product], []])
      .mockResolvedValueOnce([[{ openingStock: '10.250' }], []])
      .mockResolvedValueOnce([[{ id: 702, movementType: 'R', warehouse, quantity: 2 }], []]);

    const result = await new LegacyMysqlProductPanelsDataSource().getPanel(
      panel.product.id,
      'ledger',
      { offset: 100, limit: 100, ledger: { warehouse, movementType: 'R', openingMovementType } },
    );

    const [openingQuery, openingParams] = execute.mock.calls[1]!;
    const [pageQuery, pageParams] = execute.mock.calls[2]!;
    expect(openingQuery).toEqual(expect.stringContaining('ALMCANT FROM falm WHERE ALMKEY = ?'));
    expect(openingQuery).toEqual(expect.stringContaining('SUM(faxinv.AICANT)'));
    expect(openingParams).toEqual([
      panel.product.code.padEnd(13, ' ') + warehouse,
      panel.product.id,
      warehouse,
      ...(openingMovementType === undefined ? [] : [openingMovementType]),
    ]);
    expect(pageQuery).toEqual(expect.stringContaining(
      "AND COALESCE(faxinv.AIALMACEN, '') = ? AND faxinv.AITIPMV = ? ORDER BY finv.ISEQ, faxinv.AISEQ LIMIT ? OFFSET ?",
    ));
    expect(pageParams).toEqual([panel.product.id, warehouse, 'R', 100, 100]);
    expect(result).toMatchObject({ openingStock: 10.25, items: [{ id: 702, movementType: 'R', warehouse }] });
  });

  it('responde 404 cuando el producto no existe', async () => {
    const repository: ProductPanelsRepository = {
      getPanel: async () => null,
      setBlocked: async () => null,
    };
    await expect(new GetProductPanel(repository).execute(999999, 'ledger', 1, 25))
      .rejects.toMatchObject({ code: 'NOT_FOUND', statusCode: 404 });
  });

  it.each([
    ['customer-orders', 1],
    ['customer-quotes', 4],
  ] as const)('excluye las partidas surtidas antes de sumar y paginar %s', async (key, documentType) => {
    const execute = vi.mocked(legacyMysqlPool.execute).mockReset();
    execute
      .mockResolvedValueOnce([[panel.product], []])
      .mockResolvedValueOnce([[{ remaining: '602.375', assigned: '45.125' }], []])
      .mockResolvedValueOnce([[{ id: 711, assignedPieces: 4 }], []]);

    const response = await new GetProductPanel(new LegacyMysqlProductPanelsDataSource())
      .execute(panel.product.id, key, 2, 500, { excludeFulfilled: true });

    const [totalQuery, totalParams] = execute.mock.calls[1]!;
    const [pageQuery, pageParams] = execute.mock.calls[2]!;
    for (const query of [totalQuery, pageQuery]) {
      expect(query).toEqual(expect.stringContaining(
        `fpenc.PEMULTICIA = 1 AND PESPEDIDO = ${documentType} AND PLSURT < PLCANT`,
      ));
    }
    expect(totalQuery).toEqual(expect.stringContaining('COALESCE(SUM(PLCANT), 0) - COALESCE(SUM(PLSURT), 0)'));
    expect(totalQuery).toEqual(expect.stringContaining('SUM(PLASIGNADO)'));
    expect(totalQuery).not.toEqual(expect.stringContaining('LIMIT'));
    expect(totalParams).toEqual([panel.product.id]);
    expect(pageQuery).toEqual(expect.stringContaining('ORDER BY PEDESDE, FPLIN.PLSEQ LIMIT ? OFFSET ?'));
    expect(pageParams).toEqual([panel.product.id, 500, 500]);
    expect(response.data).toMatchObject({
      customerOrdersTotals: { remaining: 602.375, assigned: 45.125 },
      items: [{ id: 711, assignedPieces: 4 }],
    });
  });

  it('permite documentar botones sin modulo sin inventar datos', async () => {
    const repository: ProductPanelsRepository = {
      getPanel: async () => ({
        ...panel,
        key: 'photo',
        button: 'Foto',
        available: false,
        source: 'not-available',
        items: [],
        reason: 'Sin consulta MySQL',
      }),
      setBlocked: async () => null,
    };
    const response = await new GetProductPanel(repository).execute(47087, 'photo', 1, 25);
    expect(response.data).toMatchObject({ available: false, items: [] });
  });

  it('abre pedidos por asterisco sin partidas hasta pulsar un clasificador', async () => {
    const execute = vi.mocked(legacyMysqlPool.execute).mockReset();
    execute.mockResolvedValueOnce([[panel.product], []]);

    const result = await new LegacyMysqlProductPanelsDataSource().getPanel(
      panel.product.id, 'customer-orders-star', { limit: 500, offset: 0 },
    );

    expect(execute).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      available: true, items: [], customerOrdersTotals: { remaining: 0, assigned: 0 },
    });
  });

  it('carga pedidos por asterisco con el clasificador y el orden elegidos', async () => {
    const execute = vi.mocked(legacyMysqlPool.execute).mockReset();
    const line = { id: 701, classifierCode: '9ABC', classifierName: 'Proyecto' };
    execute
      .mockResolvedValueOnce([[panel.product], []])
      .mockResolvedValueOnce([[line], []])
      .mockResolvedValueOnce([[{ remaining: 10, assigned: 6 }], []]);

    const result = await new LegacyMysqlProductPanelsDataSource().getPanel(
      panel.product.id, 'customer-orders-star',
      { limit: 500, offset: 500, customerClassifier: 9, customerOrderSort: 'name' },
    );

    const [query, params] = execute.mock.calls[1]!;
    expect(query).toEqual(expect.stringContaining('fcli.CLIPAR9 AS classifierCode'));
    expect(query).toEqual(expect.stringContaining('AGTNUM = fcli.CLIPAR9'));
    expect(query).toEqual(expect.stringContaining('fpenc.PEMULTICIA = 1 ORDER BY classifierName'));
    expect(query).not.toEqual(expect.stringContaining('PESPEDIDO'));
    expect(params).toEqual([panel.product.id, 500, 500]);
    expect(result).toMatchObject({
      items: [line], customerOrdersTotals: { remaining: 10, assigned: 6 },
    });
  });

  it('usa la raíz de la compañía y agrupa pedidos CT antes de paginar', async () => {
    const execute = vi.mocked(legacyMysqlPool.execute).mockReset();
    execute
      .mockResolvedValueOnce([[panel.product], []])
      .mockResolvedValueOnce([[{ prefix: '00421' }], []])
      .mockResolvedValueOnce([[{ orderNumber: 'P200', quantity: 12, fulfilled: 5 }], []]);

    const result = await new LegacyMysqlProductPanelsDataSource().getPanel(
      panel.product.id, 'customer-orders-ct', { limit: 500, offset: 0 },
    );

    const [root, range] = execute.mock.calls.slice(1);
    expect(root).toEqual([expect.stringContaining('LEFT(?, CIARAIZ)'), [panel.product.code]]);
    expect(range).toEqual([expect.stringContaining('SUM(PLCANT) OVER (PARTITION BY PENUM)'), ['00421', '00421z', 500, 0]]);
    expect(result?.items).toEqual([{ orderNumber: 'P200', quantity: 12, fulfilled: 5 }]);
  });

  it('agrupa las ventas por código y conserva los totales al ordenar páginas', async () => {
    const execute = vi.mocked(legacyMysqlPool.execute).mockReset();
    execute
      .mockResolvedValueOnce([[panel.product], []])
      .mockResolvedValueOnce([[{ quantity: 100, amount: 450 }], []])
      .mockResolvedValueOnce([[{ customerCode: '001', quantity: 8, amount: 40 }], []]);

    const result = await new LegacyMysqlProductPanelsDataSource().getPanel(
      panel.product.id, 'customer-sales', { limit: 10, offset: 20, customerSalesSort: 'amount' },
    );

    const [total, page] = execute.mock.calls.slice(1);
    expect(total).toEqual([expect.stringContaining('SUM(AICANTF * AIPRECIO)'), [panel.product.id]]);
    expect(page?.[0]).toEqual(expect.stringContaining('PARTITION BY CLICOD'));
    expect(page?.[0]).toEqual(expect.stringContaining('ORDER BY amount, id LIMIT ? OFFSET ?'));
    expect(page?.[1]).toEqual([panel.product.id, 10, 20]);
    expect(result).toMatchObject({ customerSalesTotals: { quantity: 100, amount: 450 } });
  });

  it('ventas por asterisco permanece vacía hasta elegir y suma por clasificador', async () => {
    const execute = vi.mocked(legacyMysqlPool.execute).mockReset();
    const datasource = new LegacyMysqlProductPanelsDataSource();
    const criteria = { limit: 500, offset: 0 };
    execute.mockResolvedValueOnce([[panel.product], []]);
    expect(await datasource.getPanel(panel.product.id, 'customer-sales-star', criteria)).toMatchObject({
      items: [], customerSalesTotals: { quantity: 0, amount: 0 },
    });
    expect(execute).toHaveBeenCalledTimes(1);
    execute.mockClear();
    execute
      .mockResolvedValueOnce([[panel.product], []])
      .mockResolvedValueOnce([[{ customerCode: '3', customerName: 'Sucursal' }], []])
      .mockResolvedValueOnce([[{ quantity: 7, amount: 130 }], []]);

    const response = await datasource.getPanel(panel.product.id, 'customer-sales-star', {
      ...criteria, customerClassifier: 3, customerSalesSort: 'name',
    });

    const [query, params] = execute.mock.calls[1]!;
    expect(query).toEqual(expect.stringContaining("GROUP BY COALESCE(fcli.CLIPAR3, '')"));
    expect(query).toEqual(expect.stringContaining('ORDER BY customerName, id LIMIT'));
    expect(query).not.toEqual(expect.stringContaining('DESFACT'));
    expect(params).toEqual([panel.product.id, 500, 0]);
    expect(response).toMatchObject({
      items: [{ customerCode: '3', customerName: 'Sucursal' }],
      customerSalesTotals: { quantity: 7, amount: 130 },
    });
  });

  it.each([
    { movements: '1', query: 'DFECHA >= ? AND DEST = ?', params: [47087, '2020-01-01', 0] },
    { movements: '0', query: 'FROM fvanu2', params: [47087, 0] },
  ])('selecciona el origen de ventas anuales según la compañía ($movements)', async ({ movements, query, params }) => {
    const execute = vi.mocked(legacyMysqlPool.execute).mockReset();
    execute
      .mockResolvedValueOnce([[panel.product], []])
      .mockResolvedValueOnce([[{ movements, fromDate: '2020-01-01', state: 0 }], []])
      .mockResolvedValueOnce([[{ january: 40, total: 50 }], []])
      .mockResolvedValueOnce([[{ year: 2020, january: 10, total: 10 }], []]);

    const result = await new LegacyMysqlProductPanelsDataSource().getPanel(
      panel.product.id, 'annual-sales-summary', { offset: 5, limit: 5 },
    );

    const [total, page] = execute.mock.calls.slice(2);
    expect(total).toEqual([expect.stringContaining(query), params]);
    expect(page).toEqual([expect.stringContaining(query), [...params, 5, 5]]);
    expect(result).toMatchObject({
      items: [{ year: 2020, total: 10 }],
      annualSalesDetails: { fromDate: movements === '1' ? '2020-01-01' : null, totals: { january: 40, total: 50 } },
    });
  });

  it('limita los pedidos a proveedor a la compañía y calcula Por llegar con cantidades sin convertir', async () => {
    const execute = vi.mocked(legacyMysqlPool.execute).mockReset();
    vi.mocked(purchaseOrderRemovalSource.legacyPurchaseOrderRemovals).mockResolvedValueOnce([{ id: 42, number: 'OC00042' }]);
    execute
      .mockResolvedValueOnce([[panel.product], []])
      .mockResolvedValueOnce([[{ remaining: 40, assigned: 10 }], []])
      .mockResolvedValueOnce([[{ id: 33, orderId: 72, orderNumber: 'OC00072', quantity: 20, fulfilled: 0, factor: 10 }], []]);
    vi.mocked(purchaseOrderLineAssignments).mockResolvedValueOnce([{ id: 33, orderId: 72, number: 'OC00072', assigned: 20 }]);
    const result = await new LegacyMysqlProductPanelsDataSource().getPanel(
      panel.product.id, 'supplier-orders', { limit: 10, offset: 20, excludeFulfilled: true },
    );

    const [total, page] = execute.mock.calls.slice(1);
    for (const query of [total?.[0], page?.[0]]) {
      expect(query).toEqual(expect.stringContaining('fpenc.PEMULTICIA = 1'));
      expect(query).toEqual(expect.stringContaining('AND PLSURT < PLCANT'));
      expect(query).toEqual(expect.stringContaining('AND (fpenc.PESEQ, fpenc.PENUM) NOT IN ((?, ?))'));
    }
    expect(total?.[0]).toEqual(expect.stringContaining('SUM(PLCANT), 0) - COALESCE(SUM(PLSURT)'));
    expect(page?.[0]).toEqual(expect.stringContaining('SELECT COML4 FROM fcoment'));
    expect(total?.[1]).toEqual([panel.product.id, 42, 'OC00042']);
    expect(page?.[1]).toEqual([panel.product.id, 42, 'OC00042', 10, 20]);
    expect(result).toMatchObject({
      supplierOrdersTotals: { remaining: 40 },
      items: [{ quantity: 20, factor: 10, assigned: 20 }],
    });
  });

  it('devuelve el estado confirmado al bloquear', async () => {
    const repository: ProductPanelsRepository = {
      getPanel: async () => panel,
      setBlocked: async (_productId, blocked) => ({
        product: panel.product,
        blocked,
        deactivatedAt: blocked ? '2026-08-26' : null,
      }),
    };
    await expect(new SetProductBlockStatus(repository).execute(47087, true))
      .resolves.toMatchObject({ blocked: true, deactivatedAt: '2026-08-26' });
  });
});
