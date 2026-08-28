import { describe, expect, it } from 'vitest';
import { CreateProduct } from '../src/modules/inventories/products/application/use-cases/create-product.js';
import { DeleteProduct } from '../src/modules/inventories/products/application/use-cases/delete-product.js';
import { GetFirstActiveProduct } from '../src/modules/inventories/products/application/use-cases/get-first-active-product.js';
import { NavigateProduct } from '../src/modules/inventories/products/application/use-cases/navigate-product.js';
import { Product } from '../src/modules/inventories/products/domain/entities/product.js';
import type { ProductsRepository } from '../src/modules/inventories/products/domain/repositories/products-repository.js';

const product = Product.create({
  id: 47087,
  code: '004212899',
  description: 'Producto de prueba',
  isActive: true,
  deactivatedAt: null,
  classification: {
    type: 'set',
    familyCode: 'CONRBUA0114009',
    unit: { id: 1, code: 'PZ', description: 'PIEZA' },
    usesColorAndSize: false,
    hasPhoto: false,
  },
  prices: {
    sale: [
      { amount: 0, currencyId: 1 },
      { amount: 0, currencyId: 0 },
      { amount: 0, currencyId: 0 },
    ],
    costs: { average: 0, last: 0, previous: 0, currencyId: 0, adValorem: 0 },
  },
  warehouse: {
    minimum: 0,
    maximum: 0,
    location: '',
    ean: 'RB21/2X23000',
    upc: '',
    accounts: { primary: '1115004', secondary: '4001001', costOfSales: '5001001' },
  },
  accumulated: {
    lastPurchaseAt: null,
    lastSaleAt: null,
    assigned: 0,
    confirmed: 0,
    customerOrders: 0,
    customerQuotes: 185,
    supplierOrders: 0,
    supplierQuotes: 0,
    currentStock: 2,
    previousStock: 0,
    accumulatedStock: 0,
    previousQuantity: 0,
    accumulatedQuantity: 0,
    pieceStock: 0,
    salesLastSixMonths: 0,
    inventoryDays: 0,
  },
  createdAt: '2020-03-09',
});

const repository = (overrides: Partial<ProductsRepository> = {}): ProductsRepository => ({
  findById: async () => product,
  findFirstActive: async () => product,
  search: async () => ({ items: [product], total: 1 }),
  findAdjacent: async () => product,
  codeExists: async () => false,
  unitExists: async () => true,
  accountingAccountExists: async () => true,
  create: async () => product,
  update: async () => product,
  delete: async () => ({ status: 'deleted' }),
  ...overrides,
});

describe('Inventarios PT - Catalogo de productos', () => {
  it('carga el primer producto activo sin ejecutar la búsqueda paginada', async () => {
    const useCase = new GetFirstActiveProduct(repository({
      search: async () => { throw new Error('No debe ejecutar search'); },
    }));

    await expect(useCase.execute()).resolves.toMatchObject({ id: 47087, code: '004212899' });
  });

  it('conserva el mapeo de tipo y acumulados visibles', () => {
    const response = product.toPrimitives();
    expect(response.classification.type).toBe('set');
    expect(response.accumulated.customerQuotes).toBe(185);
    expect(response.warehouse.accounts.secondary).toBe('4001001');
  });

  it('rechaza codigos duplicados al crear', async () => {
    const useCase = new CreateProduct(repository({ codeExists: async () => true }));
    await expect(useCase.execute({ code: '004212899', description: 'Duplicado' }))
      .rejects.toMatchObject({ code: 'PRODUCT_CODE_EXISTS', statusCode: 409 });
  });

  it('valida la unidad recibida al crear', async () => {
    const useCase = new CreateProduct(repository({ unitExists: async () => false }));
    await expect(useCase.execute({
      code: 'QAPI826',
      description: 'Temporal',
      classification: { unitId: 999 },
    })).rejects.toMatchObject({ code: 'PRODUCT_UNIT_NOT_FOUND', statusCode: 409 });
  });

  it('devuelve null al llegar al extremo de navegacion', async () => {
    const useCase = new NavigateProduct(repository({ findAdjacent: async () => null }));
    await expect(useCase.execute(47087, 'previous')).resolves.toBeNull();
  });

  it('impide borrar productos relacionados', async () => {
    const useCase = new DeleteProduct(repository({
      delete: async () => ({ status: 'in-use', relation: 'faxinv' }),
    }));
    await expect(useCase.execute(47087))
      .rejects.toMatchObject({ code: 'PRODUCT_IN_USE', statusCode: 409 });
  });
});
