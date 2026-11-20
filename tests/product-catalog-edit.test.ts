import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { UpdateProduct } from '../src/modules/inventories/products/application/use-cases/update-product.js';
import type { ProductsDataSource } from '../src/modules/inventories/products/domain/datasources/products-data-source.js';
import { Product } from '../src/modules/inventories/products/domain/entities/product.js';
import { LegacyMysqlProductsDataSource } from '../src/modules/inventories/products/infrastructure/datasources/legacy-mysql-products-data-source.js';
import { PostgresProductCatalogEditDataSource, migrateProductCatalogEdit } from '../src/modules/inventories/products/infrastructure/datasources/postgres-product-catalog-edit-data-source.js';
import { PostgresProductClassificationDataSource } from '../src/modules/inventories/products/infrastructure/datasources/postgres-product-classification-data-source.js';
import { PostgresProductOtherDataSource } from '../src/modules/inventories/products/infrastructure/datasources/postgres-product-other-data-source.js';
import { ProductsRepositoryImpl } from '../src/modules/inventories/products/infrastructure/repositories/products-repository-impl.js';
import { legacyMysqlPool } from '../src/shared/infrastructure/database/legacy-mysql-pool.js';
import type { PostgresClient } from '../src/shared/infrastructure/database/postgres-pool.js';

const db = new PGlite();
const client: PostgresClient = {
  async query<T extends object>(sql: string, values?: unknown[]) {
    if (values) return db.query<T>(sql, values);
    return (await db.exec(sql)).at(-1) as { rows: T[] };
  },
  release() {},
};

const unit1 = { id: 1, code: 'PZ', description: 'PIEZA' };
const unit3 = { id: 3, code: 'M', description: 'METRO' };

const product = (id: number) => Product.create({
  id, code: `PROD${id}`, description: 'Descripción heredada', isActive: true, deactivatedAt: null,
  classification: { type: 'assembly', familyCode: 'FAM', unit: unit1, usesColorAndSize: false, hasPhoto: false },
  prices: {
    sale: [{ amount: 7, currencyId: 1 }, { amount: 0, currencyId: 0 }, { amount: 0, currencyId: 0 }],
    costs: { average: 5, last: 6, previous: 5, currencyId: 1, adValorem: 0 },
  },
  warehouse: {
    minimum: 1, maximum: 8, location: 'ORIG', ean: '', upc: '',
    accounts: { primary: '', secondary: '', costOfSales: '' },
  },
  accumulated: {
    lastPurchaseAt: null, lastSaleAt: null, assigned: 0, confirmed: 0, customerOrders: 0, customerQuotes: 0,
    supplierOrders: 0, supplierQuotes: 0, currentStock: 3, previousStock: 0, accumulatedStock: 0,
    previousQuantity: 0, accumulatedQuantity: 0, pieceStock: 0, salesLastSixWeeks: 0, salesLastSixMonths: 0, inventoryDays: 0,
  },
  createdAt: null,
});

const legacyUpdate = vi.fn(async () => { throw new Error('MySQL update prohibited'); });
const legacy: ProductsDataSource = {
  findById: async (id) => id <= 4 ? product(id) : null,
  findFirstActive: async () => product(1),
  findAdjacent: async () => product(2),
  search: async (_query, overrides) => ({
    items: overrides?.get(1)?.description ? [product(1)] : [product(1), product(4)],
    total: overrides?.get(1)?.description ? 1 : 2,
  }),
  listUnits: async () => [unit1, unit3],
  getEditRules: async (code) => ({
    hideCosts: code === 'PROD2',
    hasComponents: code === 'PROD1',
    assemblyTypeOverride: true,
    colorCode: 'R', rowCode: 'A',
  }),
  codeExists: async () => false,
  unitExists: async (id) => [1, 3].includes(id),
  accountingAccountExists: async (account) => account === '100',
  create: async () => product(1),
  update: legacyUpdate,
  delete: async () => ({ status: 'not-found' }),
};

const connect = async () => client;
const edits = new PostgresProductCatalogEditDataSource([1, 2, 3], connect, () => true);
const otherData = new PostgresProductOtherDataSource([3], connect, () => true, [1, 2]);
const classifications = new PostgresProductClassificationDataSource([3], connect, () => true, [1, 2]);
const repo = new ProductsRepositoryImpl(legacy, classifications, otherData, edits);
const update = new UpdateProduct(repo);

beforeAll(async () => { await migrateProductCatalogEdit(client); await migrateProductCatalogEdit(client); });
afterAll(async () => { await db.close(); });

describe('Edición piloto de la ficha de inventario', () => {
  it('guarda en PostgreSQL e integra detalle, búsqueda, Clasificar y Otros', async () => {
    const before = (await repo.findById(1))!.toPrimitives();
    expect(before.editing).toMatchObject({ writable: true, revision: '0:0:0' });
    expect(before.editing?.editableFields).not.toContain('code');
    expect(await update.options(1)).toEqual({ units: [unit1, unit3] });

    const saved = await update.execute(1, {
      revision: before.editing!.revision,
      description: 'Ficha de prueba',
      classification: { type: 'finishedProduct', unitId: 3, familyCode: 'WEB', usesColorAndSize: true },
      prices: { sale: [{ amount: 21.1234 }, {}, {}], costs: { average: 9.1234, currencyId: 3 } },
      warehouse: { location: 'B2', accounts: { primary: '100' } },
      accumulated: { salesLastSixWeeks: 7, inventoryDays: 9 },
    });
    expect(saved).toMatchObject({
      description: 'Ficha de prueba',
      classification: { type: 'set', unit: unit3, familyCode: 'WEB', usesColorAndSize: true },
      prices: { sale: [{ amount: 21.1234, currencyId: 1 }, { amount: 0, currencyId: 0 }, { amount: 0, currencyId: 0 }],
        costs: { average: 9.1234, currencyId: 3 } },
      warehouse: { location: 'B2', accounts: { primary: '100' } },
      accumulated: { salesLastSixWeeks: 7, salesLastSixMonths: 7, inventoryDays: 9, currentStock: 3 },
      editing: { revision: '1:1:1' },
    });
    expect((await repo.findById(1))?.toPrimitives()).toEqual(saved);
    expect(otherData.writable(1)).toBe(false);
    expect(classifications.writable(1)).toBe(false);
    expect(await otherData.get(1)).toMatchObject({ changes: { location: 'B2', list4: 9.1234, currency6: 3, unit: 'M', colorCode: 'R', rowCode: 'A' } });
    expect(await classifications.get(1)).toMatchObject({ familyCode: 'WEB' });
    const found = await repo.search({ query: 'Ficha', status: 'all', limit: 5, offset: 0 });
    expect(found.items.map((item) => item.toPrimitives())).toEqual([saved]);
    expect(legacyUpdate).not.toHaveBeenCalled();
  });

  it('rechaza ICOD, campos bloqueados y productos fuera del piloto', async () => {
    const before = (await repo.findById(2))!.toPrimitives();
    expect(before.editing?.editableFields).not.toContain('averageCost');
    await expect(update.execute(2, { revision: '0:0:0', code: 'NUEVO' })).rejects.toMatchObject({ code: 'PRODUCT_CODE_READ_ONLY' });
    await expect(update.execute(2, { revision: '0:0:0', prices: { costs: { average: 7 } } })).rejects.toMatchObject({ code: 'PRODUCT_FIELD_READ_ONLY' });
    await expect(update.execute(2, { revision: '0:0:0', classification: { unitId: 99 } })).rejects.toMatchObject({ code: 'PRODUCT_UNIT_NOT_FOUND' });
    await expect(update.execute(4, { revision: '0:0:0', description: 'Otro' })).rejects.toMatchObject({ code: 'PRODUCT_EDIT_READ_ONLY' });
    expect(await edits.get(2)).toMatchObject({ revision: 0 });
  });

  it('invalida una edición abierta si se guarda desde Otros', async () => {
    const before = (await repo.findById(3))!.toPrimitives();
    await otherData.save(3, { revision: 0, changes: { location: 'ACTUAL' } });
    await expect(update.execute(3, { revision: before.editing!.revision, warehouse: { location: 'OBSOLETO' } }))
      .rejects.toMatchObject({ code: 'PRODUCT_EDIT_STALE' });
    expect((await repo.findById(3))?.toPrimitives()).toMatchObject({ warehouse: { location: 'ACTUAL' }, editing: { revision: '0:0:1' } });
  });

  it('aplica los campos locales como parámetros conservando paginación y conteo', async () => {
    const sql = vi.spyOn(legacyMysqlPool, 'execute').mockResolvedValueOnce([[], []]).mockResolvedValueOnce([[{ total: 0 }], []]);
    try {
      await new LegacyMysqlProductsDataSource().search(
        { query: 'web', status: 'all', limit: 2, offset: 3 }, new Map([[1, { description: 'Ficha', upc: '123' }]]),
      );
      const params = ['%web%', 1, 'Ficha', '%web%', '%web%', 1, '123', '%web%'];
      expect(sql).toHaveBeenNthCalledWith(1, expect.stringContaining('CASE FINV.ISEQ WHEN ? THEN ? ELSE IDESCR END'), [...params, 2, 3]);
      expect(sql).toHaveBeenNthCalledWith(2, expect.stringContaining('CASE FINV.ISEQ WHEN ? THEN ? ELSE IUPC END'), params);
    } finally {
      sql.mockRestore();
    }
  });
});
