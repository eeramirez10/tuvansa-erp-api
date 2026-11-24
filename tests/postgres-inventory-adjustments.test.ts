import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import express from 'express';
import request from 'supertest';
import { afterAll, expect, it, vi } from 'vitest';
import { env } from '../src/config/env.js';
import { createMovementsModule } from '../src/modules/inventories/movements/movements-module.js';
import { blankProduct } from '../src/modules/inventories/products/infrastructure/datasources/product-catalog-record.js';
import { migratePostgresProductCatalog } from '../src/modules/inventories/products/infrastructure/datasources/postgres-product-catalog-schema.js';
import { migrateProductOtherData } from '../src/modules/inventories/products/infrastructure/datasources/postgres-product-other-data-source.js';
import { localProductLedger } from '../src/modules/inventories/products/infrastructure/datasources/local-product-ledger.js';
import { ProductPanelsWithPurchaseReceptionsDataSource } from '../src/modules/inventories/products/infrastructure/datasources/product-panels-with-purchase-receptions-data-source.js';
import type { PostgresConnectionFactory } from '../src/shared/infrastructure/database/postgres-pool.js';
import { errorHandler } from '../src/shared/infrastructure/http/error-handler.js';

const db = new PGlite();
const connect: PostgresConnectionFactory = async () => ({
  async query<T extends object>(sql: string, values?: unknown[]) {
    if (values) return db.query<T>(sql, values);
    const result = await db.exec(sql);
    return { rows: (result.at(-1)?.rows ?? []) as T[] };
  },
  release() {},
});

vi.mock('../src/shared/infrastructure/database/postgres-pool.js', async (importOriginal) => ({
  ...await importOriginal<object>(),
  connectPostgres: () => connect(),
  postgresConfigured: () => true,
}));

vi.mock('../src/modules/sales/orders/infrastructure/datasources/sales-order-inventory-stock.js', async (importOriginal) => ({
  ...await importOriginal<object>(),
  readLegacySaleStock: async () => new Map(),
}));

vi.mock('../src/modules/inventories/movements/infrastructure/datasources/mysql-inventory-adjustment-references.js', () => ({
  MysqlInventoryAdjustmentReferences: class {
    async capture() {
      return {
        reason: null, defaultDate: '2026-11-24', defaultWarehouse: '01',
        types: [{ code: 'EI', name: 'ENTRADA DE INVENTARIO', sign: 1 }, { code: 'SI', name: 'SALIDA DE INVENTARIO', sign: -1 },
          { code: 'TR', name: 'TRASPASOS ENTRE ALMACENES', sign: 0 }],
        warehouses: [{ code: '01', name: 'SUC. MÉXICO' }, { code: '11', name: 'NO CALIDAD MEX' }, { code: '12', name: 'ALMACÉN 12' }],
      };
    }

    async products() {
      return new Map([[13265, {
        id: 13265, code: '01300935', description: 'Prueba', unit: 'PZ', cost: 1.2345, transferCost: 2.3456,
        active: true, simple: true, legacyOnHand: 0, legacyAssigned: 0,
      }]]);
    }

    async documentExists(number: string) { return number === 'EI1000'; }
  },
}));

afterAll(() => db.close());

it('registra EI y SI en un almacén, evita duplicados y conserva los asientos firmados al cancelar', async () => {
  env.INVENTORY_MOVEMENTS_SOURCE = 'mysql';
  const route = '/api/inventories/movements';
  const app = express().use(express.json()).use(route, createMovementsModule()).use(errorHandler);
  const input = {
    requestKey: randomUUID(), type: 'EI', date: '2026-11-24', warehouse: '01', reference: 'PRUEBA',
    lines: [{ productId: 13265, quantity: 3.75 }],
  };
  const options = await request(app).get(`${route}/capture`).expect(200);
  expect(options.body.data).toMatchObject({ writable: true, defaultWarehouse: '01' });

  await request(app).post(route).send({ ...input, document: 'EI1000' }).expect(409);
  const entry = await request(app).post(route).send(input).expect(201);
  const repeatedEntry = await request(app).post(route).send({ ...input, requestKey: input.requestKey.toUpperCase() }).expect(201);
  expect(repeatedEntry.body).toEqual(entry.body);
  expect(entry.body.data).toMatchObject({ lines: [{ quantity: 3.75, cost: 1.2345 }], totals: { quantity: 3.75, cost: 4.63 } });
  await request(app).post(route).send({ ...input, reference: 'OTRA' }).expect(409);

  const exit = { ...input, requestKey: randomUUID(), type: 'SI', lines: [{ productId: 13265, quantity: 1.25 }] };
  await request(app).post(route).send({ ...exit, warehouse: '11' }).expect(409);
  await request(app).post(route).send({ ...exit, lines: [...exit.lines, { productId: 13265, quantity: 3 }] }).expect(409);
  const postedExit = await request(app).post(route).send(exit).expect(201);
  expect(postedExit.body.data).toMatchObject({ lines: [{ quantity: -1.25 }], totals: { quantity: -1.25, cost: -1.54 } });

  const entryUrl = `${route}/${entry.body.data.header.id}`;
  const exitUrl = `${route}/${postedExit.body.data.header.id}`;
  const entryWithDispatchedStock = await request(app).get(entryUrl).expect(200);
  expect(entryWithDispatchedStock.body.data.cancellationAvailable).toBe(false);
  await request(app).delete(entryUrl).expect(409);
  await request(app).delete(exitUrl).expect(204);
  await request(app).delete(entryUrl).expect(204);
  await request(app).delete(entryUrl).expect(204);

  const canceledEntry = await request(app).get(entryUrl).expect(200);
  expect(canceledEntry.body.data).toMatchObject({ cancellationAvailable: false, lines: [{ type: 'K', quantity: 0, cost: 0 }] });
  const ledger = await db.query(`SELECT count(*)::int AS rows, SUM(quantity)::float8 AS balance
    FROM tuvansa.inventory_adjustment_stock WHERE product_id=13265 AND warehouse='01'`);
  expect(ledger.rows).toEqual([{ rows: 4, balance: 0 }]);
  const original = await db.query('SELECT original_movement AS original FROM tuvansa.inventory_adjustments WHERE id=$1', [entry.body.data.header.id]);
  expect(original.rows).toEqual([{ original: entry.body.data }]);
}, 30000);

it('registra un TR con ambas partidas y solo lo cancela si hay existencia libre en destino', async () => {
  const route = '/api/inventories/movements';
  const app = express().use(express.json()).use(route, createMovementsModule()).use(errorHandler);
  const base = { date: '2026-11-24', warehouse: '01', lines: [{ productId: 13265, quantity: 3.75 }] };
  const capture = await request(app).get(`${route}/capture`).expect(200);
  expect(capture.body.data.types).toContainEqual({ code: 'TR', name: 'TRASPASOS ENTRE ALMACENES', sign: 0 });
  const transfer = { ...base, requestKey: randomUUID(), type: 'TR', warehouse: '01', destinationWarehouse: '11', reference: 'PRUEBA-TR' };
  await request(app).post(route).send({ ...transfer, destinationWarehouse: '01' }).expect(400);
  await request(app).post(route).send({ ...transfer, destinationWarehouse: '99' }).expect(422);
  await request(app).post(route).send(transfer).expect(409);
  const initial = await request(app).post(route).send({ ...base, requestKey: randomUUID(), type: 'EI' }).expect(201);
  const tr = await request(app).post(route).send(transfer).expect(201);
  expect(tr.body.data).toMatchObject({ header: { type: 'TR', warehouse: '11', reference2: '01' }, lines: [
    { quantity: -3.75, cost: 2.3456, warehouse: '01', type: 'TR' }, { quantity: 3.75, cost: 2.3456, warehouse: '11', type: 'TR' },
  ], totals: { quantity: 0, cost: 0 } });
  expect((await request(app).post(route).send(transfer).expect(201)).body).toEqual(tr.body);
  await request(app).post(route).send({ ...transfer, destinationWarehouse: '12' }).expect(409);

  const id = tr.body.data.header.id;
  const trPath = `${route}/${id}`;
  for (const [warehouse, quantity] of [['01', -3.75], ['11', 3.75]] as const) {
    const ledger = await localProductLedger(13265, { warehouse, movementType: 'TR' }, 10, async () => 0);
    expect(ledger.items).toMatchObject([{ documentId: id, warehouse, quantity, cost: 2.3456 }]);
  }

  const exit = await request(app).post(route).send({ ...base, warehouse: '11', requestKey: randomUUID(), type: 'SI' }).expect(201);
  expect((await request(app).get(trPath).expect(200)).body.data).toMatchObject({ cancellationAvailable: false });
  await request(app).delete(trPath).expect(409);
  await request(app).delete(`${route}/${exit.body.data.header.id}`).expect(204);
  expect((await request(app).get(trPath).expect(200)).body.data).toMatchObject({ cancellationAvailable: true });
  await request(app).delete(trPath).expect(204);
  await request(app).delete(trPath).expect(204);
  expect((await request(app).get(trPath).expect(200)).body.data).toMatchObject({ cancellationAvailable: false,
    lines: [{ warehouse: '01', type: 'K', quantity: 0, cost: 0 }, { warehouse: '11', type: 'K', quantity: 0, cost: 0 }] });

  const { rows } = await db.query(`SELECT warehouse,reversal,quantity::float8 FROM tuvansa.inventory_adjustment_stock
    WHERE adjustment_id=$1 ORDER BY reversal,warehouse`, [id]);
  expect(rows).toEqual([{ warehouse: '01', reversal: false, quantity: -3.75 }, { warehouse: '11', reversal: false, quantity: 3.75 },
    { warehouse: '01', reversal: true, quantity: 3.75 }, { warehouse: '11', reversal: true, quantity: -3.75 }]);
  await request(app).delete(`${route}/${initial.body.data.header.id}`).expect(204);
}, 30000);

it('habilita el producto web desde Otros y respeta almacén, paginación y filtro XXX en su Auxiliar', async () => {
  const client = await connect();
  await migratePostgresProductCatalog(client);
  await migrateProductOtherData(client);
  const id = 5000000000;
  const product = blankProduct(id, '2026-11-24');
  product.code = 'PRUEBA-INV';
  product.classification.unit = { id: 1, code: 'PZ', description: 'PIEZA' };
  await db.query("INSERT INTO tuvansa.inventory_product_snapshot (product_count) VALUES (1)");
  await db.query('INSERT INTO tuvansa.inventory_products (id,document,revision) VALUES($1,$2,1)', [id, JSON.stringify(product)]);

  const panels = new ProductPanelsWithPurchaseReceptionsDataSource();
  const fresh = await panels.getPanel(id, 'warehouses', { limit: 10, offset: 0 });
  expect(fresh).toMatchObject({ product: { id, code: 'PRUEBA-INV' }, items: [], available: true });
  const route = '/api/inventories/movements';
  const app = express().use(express.json()).use(route, createMovementsModule()).use(errorHandler);
  const input = {
    requestKey: randomUUID(), type: 'EI', date: '2026-11-24', warehouse: '01', lines: [{ productId: id, quantity: 1.75 }],
  };
  await request(app).post(route).send(input).expect(422);
  await db.query('INSERT INTO tuvansa.inventory_product_other_data (product_id,revision,changes) VALUES($1,1,$2)',
    [id, JSON.stringify({ noInventoryLayer: true, list5: 7.5 })]);

  const entry = await request(app).post(route).send(input).expect(201);
  expect(entry.body.data.lines).toMatchObject([{ productCode: product.code, unit: 'PZ', cost: 7.5, quantity: 1.75 }]);
  const secondEntry = await request(app).post(route).send({ ...input, requestKey: randomUUID() }).expect(201);
  await request(app).delete(`${route}/${secondEntry.body.data.header.id}`).expect(204);
  const ledger = { warehouse: '01' };
  const firstPage = await panels.getPanel(id, 'ledger', { limit: 1, offset: 0, ledger });
  expect(firstPage).toMatchObject({ openingStock: 0, items: [{ document: entry.body.data.header.document, quantity: 1.75 }] });
  const secondPage = await panels.getPanel(id, 'ledger', { limit: 1, offset: 1, ledger });
  expect(secondPage).toMatchObject({ openingStock: 0, items: [{ document: secondEntry.body.data.header.document, movementType: 'K', quantity: 0 }] });
  const filtered = await panels.getPanel(id, 'ledger', { limit: 1, offset: 0, ledger: { ...ledger, movementType: 'R', openingMovementType: 'R' } });
  expect(filtered).toMatchObject({ openingStock: 1.75, items: [] });
  const otherWarehouse = await panels.getPanel(id, 'ledger', { limit: 1, offset: 0, ledger: { warehouse: '11' } });
  expect(otherWarehouse).toMatchObject({ openingStock: 0, items: [] });
}, 30000);
