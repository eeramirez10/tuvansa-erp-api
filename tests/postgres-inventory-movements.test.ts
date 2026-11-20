import { PGlite } from '@electric-sql/pglite';
import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { env } from '../src/config/env.js';
import type { MovementDocument, MovementHeader, MovementLine } from '../src/modules/inventories/movements/domain/entities/inventory-movement.js';
import { migrateInventoryMovements } from '../src/modules/inventories/movements/infrastructure/datasources/postgres-inventory-movements-schema.js';
import { stageInventoryMovements, type InventoryMovementSnapshot } from '../src/modules/inventories/movements/infrastructure/datasources/postgres-inventory-movements-snapshot.js';
import { PostgresMovementsDataSource } from '../src/modules/inventories/movements/infrastructure/datasources/postgres-movements-data-source.js';
import { MovementCancellationRepositoryImpl, MovementsRepositoryImpl } from '../src/modules/inventories/movements/infrastructure/repositories/movements-repository-impl.js';
import { createMovementsModule } from '../src/modules/inventories/movements/movements-module.js';
import type { PostgresConnectionFactory } from '../src/shared/infrastructure/database/postgres-pool.js';
import { errorHandler } from '../src/shared/infrastructure/http/error-handler.js';
import { postgresWriteBoundary } from '../src/shared/infrastructure/http/postgres-write-boundary.js';

const db = new PGlite();
let simulateLostWarehouse = false;
const connect: PostgresConnectionFactory = async () => ({
  query: async <T extends object>(sql: string, values?: unknown[]) => {
    if (values) {
      const result = await db.query<T>(sql, values);
      if (simulateLostWarehouse && sql.startsWith('UPDATE tuvansa.inventory_movement_warehouse_balances')) {
        return { rows: [] };
      }
      return result;
    }
    const results = await db.exec(sql);
    return { rows: (results.at(-1)?.rows ?? []) as T[] };
  },
  release() {},
});
const adapter = new PostgresMovementsDataSource(connect);

const line = (quantity: number, pieces: number, overrides?: Partial<MovementLine>): MovementLine => ({
  id: 100, productId: 9, productCode: 'PRODUCTO', description: 'Prueba', quantity, unit: 'M',
  cost: 2.5, pieces, piecesText: String(pieces), warehouse: '01', type: 'E', lotId: 0, userId: 3,
  ...overrides,
});

const movement = (id: number, lines: MovementLine[], overrides?: Partial<MovementHeader>): MovementDocument => ({
  header: {
    id, document: `EI${id}`, date: '2024-11-19', reference: '100% ABC', reference2: '',
    warehouse: '01', supplierCode: 'PROVEEDOR', customerCode: '', customerName: '',
    type: 'E', status: 0, company: 1, userId: 3, inventoryFlag: 1, billingFlag: 0,
    ...overrides,
  },
  lines,
  totals: lines.reduce(({ quantity, cost }, item) => ({
    quantity: quantity + item.quantity, cost: cost + item.quantity * item.cost,
  }), { quantity: 0, cost: 0 }),
});

const snapshot = (
  documents: MovementDocument[],
  overrides?: Partial<InventoryMovementSnapshot>,
): InventoryMovementSnapshot => ({
  policy: { warehouseTracking: true, layerEffects: false, transitEffects: false },
  documents,
  products: [{ productId: 9, quantity: '5.500', pieces: '2.25' }],
  warehouses: [
    { productId: 9, warehouse: '01', quantity: '1.800' },
    { productId: 9, warehouse: '02', quantity: '3.700' },
  ],
  ...overrides,
});

const balances = async () => ({
  product: (await db.query(
    'SELECT quantity::text, pieces::text FROM tuvansa.inventory_movement_product_balances ORDER BY product_id',
  )).rows,
  warehouses: (await db.query(
    'SELECT warehouse, quantity::text FROM tuvansa.inventory_movement_warehouse_balances ORDER BY product_id, warehouse',
  )).rows,
});

beforeAll(async () => {
  await migrateInventoryMovements(await connect());
}, 30_000);
beforeEach(async () => {
  simulateLostWarehouse = false;
  await db.exec(`TRUNCATE tuvansa.inventory_movement_documents, tuvansa.inventory_movement_warehouse_balances,
    tuvansa.inventory_movement_product_balances, tuvansa.inventory_movement_opening`);
});
afterAll(() => db.close());

describe('Documentos de inventario locales / PostgreSQL aislado', () => {
  it('aplica la migración idempotente, prepara una apertura y busca por folio y referencia literal', async () => {
    await migrateInventoryMovements(await connect());
    const schema = await db.query<{ id: string }>('SELECT id FROM tuvansa.schema_migrations');
    expect(schema.rows).toEqual([{ id: '003_inventory_movements' }]);
    const first = movement(71, [line(1, 1)]);
    const second = movement(72, [line(1, 1)], { reference: '100ABC' });
    await stageInventoryMovements(connect, snapshot([first, second]));
    await expect(stageInventoryMovements(connect, snapshot([second])))
      .rejects.toMatchObject({ code: 'INVENTORY_MOVEMENT_SNAPSHOT_EXISTS' });
    await expect(adapter.findById(71)).resolves.toEqual(first);
    await expect(adapter.search({ document: 'ei7', reference: '100%', limit: 10, offset: 0 }))
      .resolves.toEqual({ items: [first.header], total: 1 });
    await expect(adapter.search({ document: 'EI7', limit: 1, offset: 2 }))
      .resolves.toEqual({ items: [], total: 2 });
    await expect(adapter.search({ limit: 20, offset: 0 })).resolves.toEqual({ items: [], total: 0 });
    await db.query(
      `INSERT INTO tuvansa.inventory_movement_documents (id, original_document)
       SELECT number, jsonb_set(jsonb_set($1::jsonb, '{header,id}', to_jsonb(number)),
         '{header,reference}', to_jsonb(('ABC-' || number)::text))
       FROM generate_series(100, 1100) AS number`,
      [JSON.stringify(first)],
    );
    const page = await adapter.search({ document: 'EI7', reference: 'ABC-', limit: 5, offset: 999 });
    expect(page.total).toBe(1000);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.id).toBe(998);
  });

  it('anula una entrada sin pérdida decimal, conserva ambas versiones y permite reintentos', async () => {
    const first = movement(71, [line(1.1, 0.1), line(0.2, 0.2, { id: 101 })]);
    await stageInventoryMovements(connect, snapshot([first]));
    const app = express();
    app.use('/api', postgresWriteBoundary);
    app.use('/api/inventories/movements', createMovementsModule(
      new MovementsRepositoryImpl(adapter),
      new MovementCancellationRepositoryImpl(adapter),
    ));
    app.use(errorHandler);
    const url = '/api/inventories/movements/71';
    const detail = await request(app).get(url).expect(200);
    expect(detail.body).toMatchObject({ data: { header: first.header, cancellationAvailable: true } });
    const previousSource = env.INVENTORY_MOVEMENTS_SOURCE;
    try {
      env.INVENTORY_MOVEMENTS_SOURCE = 'mysql';
      await request(app).delete(url).expect(503);
      env.INVENTORY_MOVEMENTS_SOURCE = 'postgres';
      await request(app).delete(url).expect(204);
      await request(app).delete(url).expect(204);
    } finally {
      env.INVENTORY_MOVEMENTS_SOURCE = previousSource;
    }
    const cancelledDetail = await request(app).get(url).expect(200);
    expect(cancelledDetail.body).toMatchObject({ data: {
      header: first.header,
      cancellationAvailable: false,
      cancellationReason: 'El movimiento ya está anulado.',
      totals: { quantity: 0, cost: 0, entries: 0, exits: 0 },
      lines: [{ type: 'K' }, { type: 'K' }],
    } });
    await expect(balances()).resolves.toEqual({
      product: [{ quantity: '4.200', pieces: '1.95' }],
      warehouses: [{ warehouse: '01', quantity: '0.500' }, { warehouse: '02', quantity: '3.700' }],
    });
    await expect(adapter.search({ document: 'EI', limit: 20, offset: 0 }))
      .resolves.toEqual({ items: [first.header], total: 1 });
    const audit = await db.query<{ original: MovementDocument; cancelled: MovementDocument }>(
      `SELECT original_document AS original, cancelled_document AS cancelled
       FROM tuvansa.inventory_movement_documents WHERE cancelled_at IS NOT NULL`,
    );
    expect(audit.rows[0]?.original).toEqual(first);
    expect(audit.rows[0]?.cancelled.lines).toMatchObject([
      { type: 'K', quantity: 0, pieces: 0, cost: 0 },
      { type: 'K', quantity: 0, pieces: 0, cost: 0 },
    ]);
  });

  it('resta la salida con signo de los saldos globales con seguimiento de almacén deshabilitado', async () => {
    const exit = movement(71, [line(-1.2, -1, { type: 'S' })]);
    await stageInventoryMovements(connect, snapshot([exit], {
      policy: { warehouseTracking: false, layerEffects: false, transitEffects: false },
    }));
    const before = await balances();
    await adapter.cancel(71);
    await expect(balances()).resolves.toEqual({
      product: [{ quantity: '6.700', pieces: '3.25' }],
      warehouses: before.warehouses,
    });
  });

  it('devuelve un traspaso a los almacenes de origen y destino sin cambiar el total del producto', async () => {
    const transfer = movement(71, [
      line(-0.5, -0.5, { type: 'S' }),
      line(0.5, 0.5, { id: 101, warehouse: '02' }),
    ]);
    await stageInventoryMovements(connect, snapshot([transfer]));
    const before = await balances();
    await adapter.cancel(71);
    await expect(balances()).resolves.toEqual({
      product: before.product,
      warehouses: [{ warehouse: '01', quantity: '2.300' }, { warehouse: '02', quantity: '3.200' }],
    });
  });

  it('rechaza saldos faltantes y revierte una actualización incompleta', async () => {
    const first = movement(71, [line(1, 1)]);
    const missing = movement(72, [line(1, 1, { warehouse: '99' })]);
    await stageInventoryMovements(connect, snapshot([first, missing]));
    const before = await balances();
    await expect(adapter.cancel(72)).rejects.toMatchObject({ code: 'INVENTORY_MOVEMENT_BALANCE_MISSING' });
    simulateLostWarehouse = true;
    await expect(adapter.cancel(71)).rejects.toMatchObject({ code: 'INVENTORY_MOVEMENT_BALANCE_MISSING' });
    await expect(balances()).resolves.toEqual(before);
    await expect(adapter.findById(71)).resolves.toEqual(first);
    await expect(adapter.findById(72)).resolves.toEqual(missing);
  });

  it('bloquea las variantes no verificadas antes de modificar un saldo', async () => {
    const unsupported = [
      movement(71, [line(1, 1)], { inventoryFlag: 0 }),
      movement(72, [line(1, 1)], { billingFlag: 1 }),
      movement(73, []),
      movement(74, [line(1, 1), line(0, 0, { id: 112, type: 'K' })]),
      movement(75, [line(1, 1, { lotId: 7 })]),
      movement(76, [line(1, 1)], { document: 'I201' }),
      movement(77, [line(1, 1), line(-0.5, -1, { id: 102, warehouse: '02' })]),
      movement(78, [line(1, 1, { piecesText: '1/2' })]),
    ];
    await stageInventoryMovements(connect, snapshot(unsupported));
    const before = await balances();
    for (const document of unsupported) {
      await expect(adapter.canCancel(document)).resolves.toEqual(expect.any(String));
      await expect(adapter.cancel(document.header.id)).rejects.toMatchObject({ code: 'INVENTORY_MOVEMENT_UNSUPPORTED' });
    }
    await expect(adapter.cancel(99)).rejects.toMatchObject({ code: 'INVENTORY_MOVEMENT_NOT_OWNED' });
    await expect(balances()).resolves.toEqual(before);
  });

  it('exige información explícita de almacén, capas y tránsito', async () => {
    const first = movement(71, [line(1, 1)]);
    await stageInventoryMovements(connect, snapshot([first], {
      policy: { warehouseTracking: true, layerEffects: null, transitEffects: false },
    }));
    await expect(adapter.cancel(71)).rejects.toMatchObject({ code: 'INVENTORY_MOVEMENT_UNSUPPORTED' });
    await expect(adapter.findById(71)).resolves.toEqual(first);
  });
});
