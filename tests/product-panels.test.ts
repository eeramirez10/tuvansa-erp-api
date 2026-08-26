import { describe, expect, it } from 'vitest';
import { GetProductPanel } from '../src/modules/inventories/products/application/use-cases/get-product-panel.js';
import { SetProductBlockStatus } from '../src/modules/inventories/products/application/use-cases/set-product-block-status.js';
import type {
  ProductPanelResult,
  ProductPanelsRepository,
} from '../src/modules/inventories/products/domain/repositories/product-panels-repository.js';

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

  it('responde 404 cuando el producto no existe', async () => {
    const repository: ProductPanelsRepository = {
      getPanel: async () => null,
      setBlocked: async () => null,
    };
    await expect(new GetProductPanel(repository).execute(999999, 'ledger', 1, 25))
      .rejects.toMatchObject({ code: 'NOT_FOUND', statusCode: 404 });
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
