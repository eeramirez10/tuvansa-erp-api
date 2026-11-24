import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { blankProduct } from '../src/modules/inventories/products/infrastructure/datasources/product-catalog-record.js';
import { migratePostgresProductCatalog } from '../src/modules/inventories/products/infrastructure/datasources/postgres-product-catalog-schema.js';
import { stageProductCatalog, type LegacyProductSnapshot } from '../src/modules/inventories/products/infrastructure/datasources/postgres-product-catalog-snapshot.js';
import { PostgresProductsDataSource } from '../src/modules/inventories/products/infrastructure/datasources/postgres-products-data-source.js';
import type { PostgresConnectionFactory } from '../src/shared/infrastructure/database/postgres-pool.js';
import { migratePostgres } from '../src/shared/infrastructure/datasources/postgres-schema.js';

const db = new PGlite();
const connect: PostgresConnectionFactory = async () => ({
  query: async <T extends object>(sql: string, args?: unknown[]) => {
    if (args) return db.query<T>(sql, args.map((value) =>
      value !== null && typeof value === 'object' && !Array.isArray(value) ? JSON.stringify(value) : value));
    const results = await db.exec(sql);
    return { rows: (results.at(-1)?.rows ?? []) as T[] };
  },
  release() {},
});
const catalog = new PostgresProductsDataSource(connect);
const first = blankProduct(14, '2026-01-01');
first.code = 'PZ1';
first.accumulated.currentStock = 10.25;
first.accumulated.previousStock = 20;
first.accumulated.pieceStock = 2;
first.warehouse.ean = '013784';
const legacyDuplicate = blankProduct(15, '2026-01-01');
legacyDuplicate.code = 'PZ1';
legacyDuplicate.isActive = false;
legacyDuplicate.deactivatedAt = '2026-01-02';
const third = blankProduct(16, '2026-01-01');
third.code = 'PZ2';

const snapshot = (currentStock = '10.250000'): LegacyProductSnapshot => ({
  totals: { productCount: 3, currentStock, previousStock: '20', pieceStock: '2' },
  units: [
    { id: 1, code: 'PZ', description: 'Pieza', usesColorAndSize: false },
    { id: 2, code: 'CM', description: 'Centímetros', usesColorAndSize: true },
  ],
  accounts: ['ABC-0001'],
  products: (async function* () {
    yield [
      { document: first, deletionRelation: 'faxinv' },
      { document: legacyDuplicate, deletionRelation: null },
    ];
    yield [{ document: third, deletionRelation: null }];
  })(),
});

beforeAll(async () => {
  await migratePostgresProductCatalog(await connect());
  await migratePostgres(await connect());
}, 30_000);
afterAll(() => db.close());

describe('catálogo de productos / PostgreSQL aislado', () => {
  it('exige una copia conciliada y registra migraciones repetibles junto a Pedidos', async () => {
    await expect(catalog.findFirstActive()).rejects.toMatchObject({ code: 'PRODUCT_SNAPSHOT_REQUIRED' });
    await migratePostgresProductCatalog(await connect());
    await migratePostgres(await connect());
    const result = await db.query<{ id: string }>('SELECT id FROM tuvansa.schema_migrations ORDER BY id');
    expect(result.rows.map(({ id }) => id)).toEqual(['001_orders_overlay', '002_inventory_product_catalog']);
  });

  it('reimporta sin duplicar, concilia y revierte una copia que difiere de MySQL', async () => {
    expect(await stageProductCatalog(connect, snapshot())).toMatchObject({ productCount: 3, currentStock: '10.250000' });
    await stageProductCatalog(connect, snapshot());
    await expect(stageProductCatalog(connect, snapshot('99'))).rejects.toThrow('no concilió');
    expect((await catalog.findById(14))?.toPrimitives()).toMatchObject(first);
    expect((await catalog.search({ status: 'all', offset: 10, limit: 1 }))).toEqual({ total: 3, items: [] });
  });

  it('navega por códigos distintos y conserva los duplicados en la búsqueda', async () => {
    expect((await catalog.findFirstActive())?.toPrimitives().id).toBe(14);
    expect((await catalog.findAdjacent(14, 'next'))?.toPrimitives().id).toBe(16);
    expect(await catalog.findAdjacent(15, 'previous')).toBeNull();
    expect((await catalog.findAdjacent(16, 'previous'))?.toPrimitives().id).toBe(15);
    const inactive = await catalog.search({ status: 'inactive', offset: 0, limit: 20 });
    expect(inactive.items.map((item) => item.toPrimitives().id)).toEqual([15]);
    const ean = await catalog.search({ status: 'all', query: '01378', offset: 0, limit: 20 });
    expect(ean.items.map((item) => item.toPrimitives().id)).toEqual([14]);
  });

  it('conserva referencias y guarda alta, edición y baja lógica exclusivamente en PostgreSQL', async () => {
    await expect(catalog.create({ code: 'pz1', description: 'Duplicado' }))
      .rejects.toMatchObject({ code: 'PRODUCT_CODE_EXISTS' });
    await expect(catalog.create({ code: 'LOCAL', description: 'Local', unitId: 756 }))
      .rejects.toMatchObject({ code: 'PRODUCT_UNIT_NOT_FOUND' });
    await expect(catalog.create({ code: 'LOCAL', description: 'Local', primaryAccount: 'INVALID' }))
      .rejects.toMatchObject({ code: 'ACCOUNTING_ACCOUNT_NOT_FOUND' });
    const record = (await catalog.create({
      code: 'LOCAL', description: 'Local', salePrice1: 123.15, primaryAccount: 'abc-0001',
    })).toPrimitives();
    expect(record).toMatchObject({ id: 5000000000, classification: { unit: { id: 1 } } });
    await expect(catalog.update(record.id, { code: 'pz1' }))
      .rejects.toMatchObject({ code: 'PRODUCT_CODE_EXISTS' });
    const modified = await catalog.update(record.id, { unitId: 2, description: 'Editado', saleCurrency1: 1 });
    expect(modified?.toPrimitives()).toMatchObject({
      description: 'Editado', classification: { unit: { id: 2 }, usesColorAndSize: true },
      prices: { sale: [{ amount: 123.15, currencyId: 1 }, { amount: 0, currencyId: 0 }, { amount: 0, currencyId: 0 }] },
    });
    expect(await catalog.delete(14)).toEqual({ status: 'in-use', relation: 'faxinv' });
    await db.query(
      'INSERT INTO tuvansa.orders (id, number, document) VALUES ($1, $2, $3::jsonb)',
      [5000000000, 'NP5000000000', JSON.stringify({ id: 5000000000, number: 'NP5000000000', lines: [{ productId: 16 }] })],
    );
    expect(await catalog.delete(16)).toEqual({ status: 'in-use', relation: 'Pedidos' });
    expect(await catalog.delete(record.id)).toEqual({ status: 'deleted' });
    expect(await catalog.findById(record.id)).toBeNull();
    expect(await catalog.delete(record.id)).toEqual({ status: 'not-found' });
    expect((await db.query('SELECT revision FROM tuvansa.inventory_products WHERE id = $1', [record.id])).rows)
      .toEqual([{ revision: 3 }]);
    await expect(stageProductCatalog(connect, snapshot())).rejects.toThrow('tiene cambios locales');
    expect((await db.query('SELECT number FROM tuvansa.orders')).rows).toEqual([{ number: 'NP5000000000' }]);
  });
});
