import { PGlite } from '@electric-sql/pglite';
import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EditProductClassification } from '../src/modules/inventories/products/application/use-cases/edit-product-classification.js';
import type { ProductClassificationCatalog } from '../src/modules/inventories/products/domain/repositories/product-classification-repository.js';
import { migrateProductClassification, PostgresProductClassificationDataSource } from '../src/modules/inventories/products/infrastructure/datasources/postgres-product-classification-data-source.js';
import { ProductClassificationRepositoryImpl } from '../src/modules/inventories/products/infrastructure/repositories/product-classification-repository-impl.js';
import { ProductClassificationsController } from '../src/modules/inventories/products/presentation/http/product-classifications-controller.js';
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
const storage = new PostgresProductClassificationDataSource([3, 5, 7], async () => client, () => true);
const catalog = (id: number): ProductClassificationCatalog => ({
  product: { id, code: '004212899', description: 'Producto de prueba' },
  familyCode: 'CONA01',
  recalculateFamily: id !== 7,
  assignments: { '2': '2CON', '4': '4A01', D: 'D04', O: 'O19' },
  labels: { '2': 'PRODUCTO', '4': 'MATERIAL', D: 'SUCURSAL' },
  options: [
    { key: '2', id: 1, code: '2CON', number: 'CON', description: 'CONEXIONES', parent: '' },
    { key: '2', id: 2, code: '2TUB', number: 'TUB', description: 'TUBOS', parent: '' },
    { key: '3', id: 3, code: '3COR', number: 'COR', description: 'CORTE', parent: 'TUB' },
    { key: '4', id: 4, code: '4A01', number: 'A01', description: 'ACERO AL CARBÓN', parent: '' },
    { key: '4', id: 5, code: '4A02', number: 'A02', description: 'ACERO INOXIDABLE', parent: '' },
    { key: 'D', id: 6, code: 'D04', number: '04', description: 'MEXICALI', parent: '' },
    { key: 'D', id: 7, code: 'D01', number: '01', description: 'MÉXICO', parent: '' },
  ],
});

const repo = new ProductClassificationRepositoryImpl({ get: async (id) => catalog(id) }, storage);
const controller = new ProductClassificationsController(new EditProductClassification(repo));
const app = express();
app.use(express.json());
app.route('/:productId').get(controller.get).patch(controller.save);
app.use(errorHandler);

beforeAll(async () => {
  await migrateProductClassification(client);
  await migrateProductClassification(client);
});
afterAll(() => db.close());

describe('Clasificar productos de inventario', () => {
  it('carga las opciones y posiciones nativas, conserva el panel anterior y restringe las escrituras al piloto', async () => {
    const { body } = await request(app).get('/4').expect(200);
    expect(body.data).toMatchObject({
      key: 'classifications',
      items: [{ familyCode: 'CONA01', level2: '2CON', level4: '4A01' }],
      classification: { revision: 0, writable: false, familyCode: 'CONA01' },
    });
    const { groups } = body.data.classification;
    expect(groups).toHaveLength(20);
    expect(groups.find((group: { key: string }) => group.key === '3')).toMatchObject({
      selectedFlag: '',
      options: [{ code: '3COR', number: 'COR', parentCode: 'TUB' }],
    });
    expect(groups.find((group: { key: string }) => group.key === 'O')).toBeUndefined();
    await request(app).patch('/4').send({ revision: 0, changes: { D: 'D01' } }).expect(403);
  });

  it('valida el padre desde el borrador y guarda en una revisión consistente con la familia concatenada', async () => {
    await request(app).patch('/3').send({ revision: 0, changes: { '3': '3COR' } }).expect(422);
    await request(app).patch('/3').send({ revision: 0, changes: { '4': 'D01' } }).expect(422);
    const { body } = await request(app).patch('/3').send({
      revision: 0, changes: { '2': '2TUB', '3': '3COR', '4': '4A02', D: 'D01' },
    }).expect(200);
    expect(body.data.classification).toMatchObject({ revision: 1, writable: true, familyCode: 'TUBCORA02' });
    const reloaded = await request(app).get('/3').expect(200);
    expect(reloaded.body.data).toEqual(body.data);
    expect(await storage.get(3)).toEqual({
      revision: 1, familyCode: 'TUBCORA02', changes: { '2': '2TUB', '3': '3COR', '4': '4A02', D: 'D01' },
    });
    expect(catalog(3).assignments.D).toBe('D04');
    await request(app).patch('/3').send({ revision: 0, changes: { D: 'D04' } }).expect(409);
  });

  it('admite el recálculo manual al guardar, incluyendo cuando la política de compañía está desactivada', async () => {
    const { body } = await request(app).patch('/7').send({ revision: 0, changes: { '4': '4A02' } }).expect(200);
    expect(body.data.classification.familyCode).toBe('CONA01');
    const recalc = await request(app).patch('/7').send({ revision: 1, changes: {}, rebuildFamily: true }).expect(200);
    expect(recalc.body.data.classification).toMatchObject({ revision: 2, familyCode: 'CONA02' });
  });

  it('rechaza la segunda escritura concurrente sobre la misma revisión', async () => {
    const attempt = (value: string) => request(app).patch('/5').send({ revision: 0, changes: { D: value } });
    const outcomes = await Promise.all([attempt('D01'), attempt('D01')]);
    expect(outcomes.map((result) => result.status).sort()).toEqual([200, 409]);
    expect(await storage.get(5)).toMatchObject({ revision: 1, changes: { D: 'D01' } });
  });
});
