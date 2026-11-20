import { PGlite } from '@electric-sql/pglite';
import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EditProductOtherData } from '../src/modules/inventories/products/application/use-cases/edit-product-other-data.js';
import type { ProductOtherDataCatalog } from '../src/modules/inventories/products/domain/repositories/product-other-data-repository.js';
import {
  migrateProductOtherData,
  PostgresProductOtherDataSource,
} from '../src/modules/inventories/products/infrastructure/datasources/postgres-product-other-data-source.js';
import { ProductOtherDataRepositoryImpl } from '../src/modules/inventories/products/infrastructure/repositories/product-other-data-repository-impl.js';
import { ProductOtherDataController } from '../src/modules/inventories/products/presentation/http/product-other-data-controller.js';
import type { PostgresClient } from '../src/shared/infrastructure/database/postgres-pool.js';
import { errorHandler } from '../src/shared/infrastructure/http/error-handler.js';

const db = new PGlite();
const client: PostgresClient = {
  async query<T extends object>(sql: string, values?: unknown[]) {
    if (values) return db.query<T>(sql, values);
    return (await db.exec(sql)).at(-1) as { rows: T[] };
  },
  release() {},
};
const storage = new PostgresProductOtherDataSource([3, 5, 7], async () => client, () => true);
const catalog = (id: number): ProductOtherDataCatalog => ({
  product: { id, code: '004212899', description: 'Producto de prueba' },
  values: {
    volume: 0, weight: 0, packaging: 0, location: '', controlsPieces: true, inactiveForPurchases: false,
    unitsPerBox: 1, lotSize: 1, changedBy: 410, changedAt: '2023-08-22', assemblyDate: '2024-09-20',
    ediPackaging: 'BX', ediQuantity: 0, list6: 0, alternateUnitPrice: 0, alternateUnitFactor: 1,
  },
  tariffs: [{ code: 'ARA2', description: 'Arancel *16%', percentage: 16 }],
  miscLabels: ['Caja'],
  derivesList6: id === 5,
});

const repository = new ProductOtherDataRepositoryImpl(
  { get: async (id) => id === 20 ? null : catalog(id) }, storage,
);
const controller = new ProductOtherDataController(new EditProductOtherData(repository));
const app = express();
app.use(express.json());
app.route('/:productId').get(controller.get).patch(controller.save);
app.use(errorHandler);

beforeAll(async () => {
  await migrateProductOtherData(client);
  await migrateProductOtherData(client);
});
afterAll(() => db.close());

describe('Otros del catálogo de inventario', () => {
  it('mantiene los datos del panel existente y expone el estado de edición', async () => {
    const { body } = await request(app).get('/4').expect(200);
    expect(body.data).toMatchObject({
      key: 'other-data',
      items: [{ controlsPieces: 1, inactiveForPurchases: 0, lotControlled: 1 }],
      otherData: {
        values: { controlsPieces: true, inactiveForPurchases: false, ediQuantity: 0, lotSize: 1 },
        writable: false, revision: 0, tariffs: [{ code: 'ARA2', percentage: 16 }], miscLabels: ['Caja'],
      },
    });
    expect(body.data.otherData.editableFields).toContain('unitsPerBox');
    expect(body.data.otherData.editableFields).not.toContain('ediQuantity');
    expect(body.data.otherData.editableFields).not.toContain('assemblyDate');
    await request(app).get('/4?page=2').expect(200).expect(({ body: next }) => {
      expect(next.data.items).toEqual([]);
      expect(next.pagination).toMatchObject({ page: 2, returned: 0 });
    });
    await request(app).get('/20').expect(404);
    await request(app).patch('/4').send({ revision: 0, changes: { volume: 12 } }).expect(403);
  });

  it('respeta la entrada nativa, guarda sobre PostgreSQL y permite restablecer los campos al valor del catálogo', async () => {
    for (const changes of [
      { unitsPerBox: 0 }, { lotSize: 0 }, { ediPackaging: 'B' }, { baseCurrency: 10 },
      { volume: 0.0000001 }, { volume: -1 }, { composition: 'X'.repeat(121) },
      { changedAt: '2026-11-20' }, { importDate: '2026-02-30' }, { ediQuantity: 1 },
    ]) {
      await request(app).patch('/3').send({ revision: 0, changes }).expect(400);
    }
    const changes = { volume: 1.123456, location: ' zona-b ', ediPackaging: 'bx', packaging: -1.25 };
    const saved = await request(app).patch('/3').send({ revision: 0, changes }).expect(200);
    expect(saved.body.data.otherData).toMatchObject({
      revision: 1, writable: true,
      values: { volume: 1.123456, location: 'ZONA-B', ediPackaging: 'BX', packaging: -1.25, changedBy: 410 },
    });
    expect(saved.body.data.otherData.values.changedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(saved.body.data.otherData.values.changedAt).not.toBe('2023-08-22');
    expect(await storage.get(3)).toMatchObject({
      revision: 1, changes: { volume: 1.123456, location: 'ZONA-B', packaging: -1.25 },
    });
    const reopened = await request(app).get('/3').expect(200);
    expect(reopened.body).toEqual(saved.body);
    expect(catalog(3).values.location).toBe('');
    await request(app).patch('/3').send({ revision: 0, changes: { location: '' } }).expect(409);
    await request(app).patch('/3').send({ revision: 1, changes: { volume: 0, location: '', packaging: 0 } }).expect(200);
    expect(await storage.get(3)).toMatchObject({ revision: 2, changes: {} });
  });

  it('recalcula la lista 6 cuando lo indica la compañía y protege revisiones concurrentes', async () => {
    const saved = await request(app).patch('/5').send({
      revision: 0, changes: { alternateUnitPrice: 10, alternateUnitFactor: 3, list6: 150 },
    }).expect(200);
    expect(saved.body.data.otherData).toMatchObject({ revision: 1, values: { list6: 3.3333 } });
    const outcomes = await Promise.all(['Primero', 'Segundo'].map((composition) =>
      request(app).patch('/7').send({ revision: 0, changes: { composition } })));
    expect(outcomes.map(({ status }) => status).sort()).toEqual([200, 409]);
  });
});
