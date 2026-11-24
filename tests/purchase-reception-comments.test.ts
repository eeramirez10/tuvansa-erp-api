import { PGlite } from '@electric-sql/pglite';
import { expect, it, vi } from 'vitest';
import { PurchaseReception, type PurchaseReceptionProps } from '../src/modules/purchasing/purchase-receptions/domain/entities/purchase-reception.js';
import type { PurchaseReceptionCommentsBase, PurchaseReceptionCommentsSource } from '../src/modules/purchasing/purchase-receptions/domain/datasources/purchase-reception-comments-data-source.js';
import { HybridPurchaseReceptionsDataSource } from '../src/modules/purchasing/purchase-receptions/infrastructure/datasources/hybrid-purchase-receptions-data-source.js';
import type { LegacyMysqlPurchaseReceptionsDataSource } from '../src/modules/purchasing/purchase-receptions/infrastructure/datasources/legacy-mysql-purchase-receptions-data-source.js';
import { MysqlPurchaseReceptionCommentsSource } from '../src/modules/purchasing/purchase-receptions/infrastructure/datasources/mysql-purchase-reception-comments-source.js';
import { localPurchasePayablesSql } from '../src/modules/purchasing/purchase-receptions/infrastructure/datasources/postgres-purchase-payables.js';
import { PostgresPurchaseReceptionComments } from '../src/modules/purchasing/purchase-receptions/infrastructure/datasources/postgres-purchase-reception-comments.js';
import { ensurePurchaseReceptionSchema } from '../src/modules/purchasing/purchase-receptions/infrastructure/datasources/postgres-purchase-reception-writes.js';
import { legacyMysqlPool } from '../src/shared/infrastructure/database/legacy-mysql-pool.js';
import * as postgres from '../src/shared/infrastructure/database/postgres-pool.js';

const id = 343982;
const fields: PurchaseReceptionCommentsBase['fields'] = {
  dueAt: '2025-03-13', supplierReference: 'REF1', department: '01', orderNumber: 'OA01', transportCode: '7',
  processDate: null, otherLabel: '', boxes: 0, volume: 0, folio: 'F-1', folioAt: '2025-02-10T12:24:33',
  lines: ['', '', '', '', 'Anterior'], amountInWords: 'CIEN PESOS', warehouse: '01',
};
const reception: PurchaseReceptionProps = {
  id, number: 'RA09226', orderNumber: fields.orderNumber, supplierReference: fields.supplierReference,
  supplier: { id: 200, code: 'P200', name: 'Proveedor' }, department: fields.department, warehouse: fields.warehouse,
  branch: 0, status: '', cancelled: false, dates: { receivedAt: '2025-02-11', dueAt: fields.dueAt, orderedAt: '2025-02-01' },
  delayDays: 0, classifications: ['', '', '', '', '', '', '7', '', ''], discountPercentages: [], lines: [],
  totals: { units: 1, pieces: 0, subtotal: 100, discount: 0, freight: 0, insurance: 0, other: 0, otherLabel: '',
    exciseTax: 0, taxPercentage: 0, tax: 0, withholdingTax: 0, total: 100, balance: 100 },
};

it('uses the exact FDOC.DSEQ for FCOMENT and converts native line and date formats', async () => {
  const source = new MysqlPurchaseReceptionCommentsSource();
  const database = vi.spyOn(legacyMysqlPool, 'execute').mockResolvedValue([[
    {
      id, number: reception.number, supplierId: 200, supplierCode: 'P200', dueAt: '2025-03-13', supplierReference: 'REF1',
      department: '01', orderNumber: 'OA01', transportCode: '7', processDate: '1900-12-31', otherLabel: '',
      boxes: 2, volume: 0.12, folio: 'F-1', folioAt: '2025-02-10 12:24:33', warehouse: '01',
      line1: '', line2: '', line3: '', line4: '', line5: 'Uno\rDos\r\nTres', amountInWords: 'CIEN PESOS',
    },
  ], []]);
  try {
    await expect(source.read(1, id)).resolves.toMatchObject({ fields: {
      lines: ['', '', '', '', 'Uno\nDos\nTres'], folioAt: '2025-02-10T12:24:33', processDate: null, boxes: 2, volume: 0.12,
    } });
    expect(database).toHaveBeenCalledWith(expect.stringContaining('c.COMSEQFACT=d.DSEQ'), [id, 1]);
    await expect(source.read(2, id)).resolves.toBeNull();
    expect(database).toHaveBeenCalledTimes(1);
  } finally { database.mockRestore(); }
});

it('edits the native comments as metadata without changing the receipt source', async () => {
  const db = new PGlite();
  const client: postgres.PostgresClient = {
    async query<T extends object>(sql: string, values?: unknown[]) {
      if (values) return db.query<T>(sql, values);
      const results = await db.exec(sql);
      return { rows: (results.at(-1)?.rows ?? []) as T[] };
    },
    release() {},
  };
  const connect = async () => client;
  const connectMock = vi.spyOn(postgres, 'connectPostgres').mockImplementation(connect);
  const configuredMock = vi.spyOn(postgres, 'postgresConfigured').mockReturnValue(true);
  const base: PurchaseReceptionCommentsBase = { reception: { id, number: reception.number, supplierCode: 'P200' },
    supplierId: 200, fields: structuredClone(fields), reason: null };
  const mysql: PurchaseReceptionCommentsSource = {
    read: async (_company, receiptId) => (receiptId === id ? structuredClone(base) : null),
    labels: vi.fn<PurchaseReceptionCommentsSource['labels']>(async () => ['', '', '', '', '']),
    transportName: async (code) => code === '702' ? 'Paquetería' : '',
  };
  const store = new PostgresPurchaseReceptionComments(mysql, connect, () => true);
  const legacy = {
    findById: async () => PurchaseReception.create(reception),
    search: async () => ({ items: [], total: 0 }),
  } as unknown as LegacyMysqlPurchaseReceptionsDataSource;
  const hybrid = new HybridPurchaseReceptionsDataSource(legacy);
  try {
    const opening = (await store.read(1, id))!;
    expect(opening).toMatchObject({ reception: base.reception, fields, canWrite: true, revision: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect((await db.query("SELECT to_regclass('tuvansa.purchase_reception_comments') AS present")).rows).toEqual([{ present: null }]);
    expect(mysql.labels).toHaveBeenCalledWith('R');
    base.fields.processDate = '2025-02-22';
    await expect(store.save(1, id, { fields, revision: opening.revision })).rejects.toMatchObject({ code: 'PURCHASE_RECEPTION_COMMENTS_CONFLICT' });

    const original = (await store.read(1, id))!;
    const changed = await store.save(1, id, { revision: original.revision, fields: {
      ...original.fields, dueAt: null, supplierReference: 'referencia 2', department: '02', transportCode: '702',
      orderNumber: 'oc02', otherLabel: 'nota', warehouse: '08', boxes: 2, volume: 0.12, folioAt: '2025-02-10',
      lines: ['L1', '', 'L3', '', 'Línea A\r\nLínea B'], amountInWords: 'CIEN EXACTOS',
    } });
    expect(changed).toMatchObject({ transportName: 'Paquetería', canWrite: true, fields: {
      dueAt: null, supplierReference: 'REFERENCIA 2', department: '02', transportCode: '702',
      orderNumber: 'OC02', otherLabel: 'NOTA', warehouse: '08', boxes: 2, volume: 0.12, folioAt: fields.folioAt,
      processDate: '2025-02-22', lines: ['L1', '', 'L3', '', 'Línea A\nLínea B'], amountInWords: 'CIEN EXACTOS',
    } });
    expect((await hybrid.findById(id))?.toPrimitives()).toMatchObject({
      orderNumber: 'OC02', warehouse: '08', department: '02', supplierReference: 'REFERENCIA 2',
      dates: { receivedAt: '2025-02-11', dueAt: null }, classifications: ['', '', '', '', '', '', '702', '', ''],
      totals: { total: 100, balance: 100, otherLabel: 'NOTA' },
    });
    expect((await legacy.findById(id))?.toPrimitives()).toEqual(reception);
    await expect(store.save(1, id, { fields: changed.fields, revision: changed.revision })).resolves.toEqual(changed);
    expect((await db.query('SELECT receipt_id::float8 AS id,revision FROM tuvansa.purchase_reception_comments')).rows)
      .toEqual([{ id, revision: 1 }]);
    base.fields.processDate = '2025-02-25';
    expect((await store.read(1, id))?.fields).toMatchObject({ warehouse: '08', processDate: '2025-02-25' });
    base.supplierId = 201;
    expect((await store.read(1, id))).toMatchObject({ canWrite: false, fields: { warehouse: '01' } });

    await ensurePurchaseReceptionSchema(client);
    const rw = { ...reception, id: 6700000000000, number: 'RW00000001', supplierReference: 'R'.repeat(30) };
    const booked = { amount: 100, currencyId: 1, exchangeRate: 1, dueAt: rw.dates.dueAt };
    await db.query(
      `INSERT INTO tuvansa.purchase_receptions
        (id,number,company_id,user_id,request_key,fingerprint,order_id,order_number,order_revision,result,movement,order_line_effects,payable,accounting)
       VALUES ($1,$2,1,1,$3,$4,55,$5,1,$6::jsonb,'{"header":{"type":"RA"}}','[]',$7::jsonb,'{"number":"3W00000001"}')`,
      [rw.id, rw.number, crypto.randomUUID(), '1'.repeat(64), rw.orderNumber, JSON.stringify({ reception: rw }), JSON.stringify(booked)],
    );
    const localOpening = (await store.read(1, rw.id))!;
    expect(localOpening).toMatchObject({ reception: { id: rw.id, number: rw.number }, fields: {
      supplierReference: rw.supplierReference, dueAt: rw.dates.dueAt, warehouse: rw.warehouse,
    } });
    const localChange = await store.save(1, rw.id, { revision: localOpening.revision, fields: {
      ...localOpening.fields, dueAt: '2025-03-31', warehouse: '02', orderNumber: 'OA02',
      lines: ['', '', '', '', 'Comentario de recepción web'],
    } });
    expect(localChange).toMatchObject({ fields: { supplierReference: rw.supplierReference, warehouse: '02', dueAt: '2025-03-31' } });
    await store.save(1, rw.id, { revision: localChange.revision, fields: { ...localChange.fields, supplierReference: 'ref%_nueva' } });
    expect((await hybrid.findByNumber(rw.number))?.toPrimitives()).toMatchObject({
      orderNumber: 'OA02', warehouse: '02', supplierReference: 'REF%_NUEVA', dates: { dueAt: '2025-03-31' }, totals: { total: 100, balance: 100 },
    });
    const page = { offset: 0, limit: 10 };
    const changedSearch = await hybrid.search({ ...page, supplierReference: 'REF%_', orderNumber: 'OA02', warehouse: '02' });
    expect(changedSearch.total).toBe(1);
    expect(changedSearch.items[0]?.toPrimitives()).toMatchObject({ supplierReference: 'REF%_NUEVA', orderNumber: 'OA02', warehouse: '02' });
    await expect(hybrid.search({ ...page, query: '%_NUEVA' })).resolves.toMatchObject({ total: 1 });
    await expect(hybrid.search({ ...page, supplierReference: rw.supplierReference })).resolves.toMatchObject({ total: 0 });
    await expect(hybrid.search({ ...page, orderNumber: rw.orderNumber })).resolves.toMatchObject({ total: 0 });
    await expect(hybrid.search({ ...page, warehouse: rw.warehouse })).resolves.toMatchObject({ total: 0 });
    const payables = await localPurchasePayablesSql(client);
    expect((await db.query(`SELECT order_number,supplier_reference,due_at::text,principal::float8 FROM (${payables}) payable`)).rows)
      .toEqual([{ order_number: rw.orderNumber, supplier_reference: rw.supplierReference, due_at: booked.dueAt, principal: 100 }]);
  } finally {
    connectMock.mockRestore();
    configuredMock.mockRestore();
    await db.close();
  }
}, 15000);
