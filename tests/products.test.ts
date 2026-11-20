import { afterEach, describe, expect, it, vi } from 'vitest';
import { CreateProduct } from '../src/modules/inventories/products/application/use-cases/create-product.js';
import { DeleteProduct } from '../src/modules/inventories/products/application/use-cases/delete-product.js';
import { GetFirstActiveProduct } from '../src/modules/inventories/products/application/use-cases/get-first-active-product.js';
import { NavigateProduct } from '../src/modules/inventories/products/application/use-cases/navigate-product.js';
import { Product } from '../src/modules/inventories/products/domain/entities/product.js';
import type { ProductsRepository } from '../src/modules/inventories/products/domain/repositories/products-repository.js';
import { LegacyMysqlProductsDataSource } from '../src/modules/inventories/products/infrastructure/datasources/legacy-mysql-products-data-source.js';
import { ProductsRepositoryImpl } from '../src/modules/inventories/products/infrastructure/repositories/products-repository-impl.js';
import { legacyMysqlPool } from '../src/shared/infrastructure/database/legacy-mysql-pool.js';

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
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([
    ['2026-11-20', '2026-11-20', true],
    ['2026-11-20', '2026-11-21', true],
    ['2026-11-21', '2026-11-23', false],
    ['2026-11-17', '2026-11-19', false],
    [null, '2026-11-21', false],
    ['2026-11-20', null, false],
  ])('lee los campos de la ficha y evalúa la oferta de %s a %s', async (offerFrom, offerUntil, hasActiveOffer) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-21T02:00:00Z')); // 20 de noviembre en Ciudad de México.
    const execute = vi.spyOn(legacyMysqlPool, 'execute').mockResolvedValueOnce([[
      {
        id: 12362, typeId: 1, colorAndSize: 0, unitType: 2, costCurrency: 0, offerFrom, offerUntil,
        unitId: 10, unitCode: 'UNO', unitDescription: 'UNO', catalogUnitCode: null, salesLastSixWeeks: 12,
      },
    ], []]);
    const result = await new LegacyMysqlProductsDataSource().findById(12362);

    expect(execute).toHaveBeenCalledWith(expect.stringContaining('FINV.ICT AS colorAndSize'), [12362]);
    expect(execute).toHaveBeenCalledWith(expect.stringContaining('IMONEDA6 AS costCurrency'), [12362]);
    expect(execute).toHaveBeenCalledWith(expect.stringContaining('candidate.UCOD = FINV.IUM'), [12362]);
    expect(execute).toHaveBeenCalledWith(expect.stringContaining('CIAOTROSDESC = 99 AND CIAKYT = 0'), [12362]);
    expect(result?.toPrimitives()).toMatchObject({
      classification: { usesColorAndSize: false, unit: { id: 10, code: 'UNO', catalogOption: null } },
      prices: { costs: { currencyId: 0 }, hasActiveOffer },
      accumulated: { salesLastSixWeeks: 12, salesLastSixMonths: 12 },
    });
  });

  it('conserva la moneda de Lista 6 aunque Otros cambie la moneda de origen', async () => {
    const values = { revision: 1, changes: { baseCurrency: 2 }, changedAt: '2026-11-20' };
    const adapter = new ProductsRepositoryImpl(repository(), undefined, { get: async () => values });
    const result = await adapter.findById(product.toPrimitives().id);
    expect(result?.toPrimitives().prices.costs.currencyId).toBe(0);

    const withList6 = new ProductsRepositoryImpl(repository(), undefined, {
      get: async () => ({ ...values, changes: { ...values.changes, currency6: 3 } }),
    });
    const updated = await withList6.findById(product.toPrimitives().id);
    expect(updated?.toPrimitives().prices.costs.currencyId).toBe(3);
  });

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
