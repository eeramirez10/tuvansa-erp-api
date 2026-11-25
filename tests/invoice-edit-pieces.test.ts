import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { EditInvoicePieces } from '../src/modules/sales/invoicing/application/use-cases/edit-invoice-pieces.js';
import { GetInvoicePanel } from '../src/modules/sales/invoicing/application/use-cases/get-invoice-panel.js';
import { GetInvoice } from '../src/modules/sales/invoicing/application/use-cases/get-invoice.js';
import type { SimulateSalesStamping } from '../src/modules/sales/invoicing/application/use-cases/simulate-sales-stamping.js';
import type { InvoicesDataSource } from '../src/modules/sales/invoicing/domain/datasources/invoices-data-source.js';
import { Invoice, type InvoiceProps } from '../src/modules/sales/invoicing/domain/entities/invoice.js';
import { InvoicePanelsWithSalesRemissionsDataSource } from '../src/modules/sales/invoicing/infrastructure/datasources/invoice-panels-with-sales-remissions-data-source.js';
import { LegacyMysqlInvoicePanelsDataSource } from '../src/modules/sales/invoicing/infrastructure/datasources/legacy-mysql-invoice-panels-data-source.js';
import { PostgresInvoicePieces } from '../src/modules/sales/invoicing/infrastructure/datasources/postgres-invoice-pieces.js';
import { InvoicesRepositoryImpl } from '../src/modules/sales/invoicing/infrastructure/repositories/invoices-repository-impl.js';
import { InvoicesController } from '../src/modules/sales/invoicing/presentation/http/invoices-controller.js';
import { createInvoicesRouter } from '../src/modules/sales/invoicing/presentation/http/invoices-routes.js';
import type { PostgresConnectionFactory } from '../src/shared/infrastructure/database/postgres-pool.js';
import { errorHandler } from '../src/shared/infrastructure/http/error-handler.js';

const { legacyExecute } = vi.hoisted(() => ({ legacyExecute: vi.fn() }));
vi.mock('../src/shared/infrastructure/database/legacy-mysql-pool.js', () => ({ legacyMysqlPool: { execute: legacyExecute } }));

const first = { id: 11, productCode: 'TEST-1', pieces: '', quantity: 4 };
const second = { id: 12, productCode: 'TEST-2', pieces: '1 x 2', quantity: 8 };
const scope = { id: 10, number: 'FA-TEST' };
const header = { ...scope, warehouse: '01', pieces: 12, totals: { quantity: 12, balance: 100 }, lines: [first, second] };
const base = '/sales/invoices/10/summaries/edit-pieces';

function fixture(db: PGlite) {
  let queue = Promise.resolve();
  let breakCommit = false;
  const connect: PostgresConnectionFactory = async () => {
    const prior = queue;
    let release = () => {};
    queue = new Promise<void>((resolve) => { release = resolve; });
    // PGlite has one connection. Queue overlapping clients while preserving production SQL and transaction boundaries.
    await prior;
    return {
      async query<T extends object>(sql: string, values?: unknown[]) {
        if (sql === 'COMMIT' && breakCommit) { breakCommit = false; throw new Error('injected before commit'); }
        if (values) return db.query<T>(sql, values);
        const result = await db.exec(sql);
        return { rows: (result.at(-1)?.rows ?? []) as T[] };
      },
      release,
    };
  };
  legacyExecute.mockReset().mockImplementation(async (sql: string) => {
    if (sql.includes('FROM FDOC WHERE')) return [[scope], []];
    return [[{ ...first }, { ...second }], []];
  });
  const store = new PostgresInvoicePieces(connect, () => true);
  const panels = new InvoicePanelsWithSalesRemissionsDataSource(new LegacyMysqlInvoicePanelsDataSource(), {} as SimulateSalesStamping, store);
  const source = { findById: async () => Invoice.create(header as unknown as InvoiceProps) } as InvoicesDataSource;
  const invoices = new InvoicesRepositoryImpl(source, store);
  const edit = new EditInvoicePieces(store, (id) => panels.readPieceLines(id));
  const controller = new InvoicesController(new GetInvoice(invoices),
    {} as never, {} as never, {} as never, {} as never, new GetInvoicePanel(panels),
    {} as never, {} as never, {} as never, edit);
  const app = express();
  app.use(express.json());
  app.use('/sales/invoices', createInvoicesRouter(controller));
  app.use(errorHandler);
  return { app, rollbackNext: () => { breakCommit = true; } };
}

describe('Facturación → Edita pzas', () => {
  it('conserva el valor de origen hasta guardar y proyecta únicamente la partida elegida', async () => {
    const db = new PGlite();
    try {
      const { app } = fixture(db);
      const original = await request(app).get(base).expect(200);
      expect(original.body.data).toMatchObject({ source: 'mysql', readOnly: false, items: [first, second] });
      expect((await db.query("SELECT to_regclass('tuvansa.sales_invoice_line_pieces') as name")).rows).toEqual([{ name: null }]);
      const value = " 3 pzas 'L' ";
      const body = { value, expectedVersion: original.body.data.items[0].version, requestKey: randomUUID() };
      await request(app).patch(`${base}/0`).send(body).expect(400);
      await request(app).patch(`${base}/99`).send(body).expect(404);
      await request(app).patch(`${base}/11`).send({ ...body, warehouse: '99' }).expect(400);
      const saved = await request(app).patch(`${base}/11`).send(body).expect(200);
      expect(saved.body.data).toMatchObject({ id: 11, pieces: value });
      expect((await request(app).patch(`${base}/11`).send(body).expect(200)).body).toEqual(saved.body);
      await request(app).patch(`${base}/11`).send({ ...body, value: 'Otro' }).expect(409);
      const detail = await request(app).get('/sales/invoices/10').expect(200);
      expect(detail.body.data).toEqual({ ...header, lines: [{ ...first, pieces: value }, second] });
      const ct = await request(app).get('/sales/invoices/10/actions/ct').expect(200);
      expect(ct.body.data.items).toEqual([{ ...first, pieces: value }, second]);
      expect((await request(app).get(base).expect(200)).body.data.items[0].version).toBe(saved.body.data.version);
      expect(legacyExecute.mock.calls.every(([sql]) => sql.startsWith('SELECT'))).toBe(true);
      const source = legacyExecute.mock.calls.find(([sql]) => sql.includes('FDOC.DESFACT'));
      expect(source?.[0]).toContain('FAXINV.AIPZAS');
      expect(source?.[1]).toEqual([10]);
    } finally {
      await db.close();
    }
  }, 15_000);

  it('revierte un fallo después del INSERT y resuelve dos sesiones con la misma revisión', async () => {
    const db = new PGlite();
    try {
      const { app, rollbackNext } = fixture(db);
      const expectedVersion = (await request(app).get(base).expect(200)).body.data.items[0].version;
      const body = { value: '7', expectedVersion, requestKey: randomUUID() };
      // Create the table with a separate line before injecting a failure into the transaction under test.
      const secondVersion = (await request(app).get(base).expect(200)).body.data.items[1].version;
      await request(app).patch(`${base}/12`).send({ value: '', expectedVersion: secondVersion, requestKey: randomUUID() }).expect(200);
      rollbackNext();
      await request(app).patch(`${base}/11`).send(body).expect(503);
      expect((await db.query('SELECT line_id::int AS id FROM tuvansa.sales_invoice_line_pieces')).rows).toEqual([{ id: 12 }]);
      const [retry, rival] = await Promise.all([
        request(app).patch(`${base}/11`).send(body),
        request(app).patch(`${base}/11`).send({ ...body, value: '8', requestKey: randomUUID() }),
      ]);
      expect([retry.status, rival.status].sort()).toEqual([200, 409]);
      expect((await db.query('SELECT revision FROM tuvansa.sales_invoice_line_pieces WHERE line_id=11')).rows).toEqual([{ revision: 1 }]);
      await request(app).patch(`${base}/11`).send({ ...body, requestKey: randomUUID() }).expect(409);
    } finally {
      await db.close();
    }
  }, 15_000);
});
