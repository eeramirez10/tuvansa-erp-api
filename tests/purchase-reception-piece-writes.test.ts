import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PostgresClient } from '../src/shared/infrastructure/database/postgres-pool.js';
import type { NativeReceiptForPieces, NativeReceiptPiece } from '../src/modules/purchasing/purchase-receptions/domain/datasources/purchase-reception-pieces-data-source.js';
import { PostgresPurchaseReceptionPieces } from '../src/modules/purchasing/purchase-receptions/infrastructure/datasources/postgres-purchase-reception-pieces.js';
import { lockPurchaseReceptionPieces, purchaseReceptionPieceProducts, retirePurchaseReceptionPieces } from '../src/modules/purchasing/purchase-receptions/infrastructure/datasources/purchase-reception-piece-reads.js';

const db = new PGlite();
const client: PostgresClient = {
  query: async (sql, values) => {
    if (!values && sql.includes(';')) { await db.exec(sql); return { rows: [] }; }
    return db.query(sql, values);
  },
  release: () => undefined,
};
const localId = 6700000000000;
const nativeReceipt: NativeReceiptForPieces = {
  id: 151, number: 'RA09214', warehouse: '01', receivedAt: '2025-01-01', canWrite: true, reason: null,
  customsEntry: 'TEST', customsOffice: '430', customsDate: '2025-01-01', version: 'base',
  lines: [{ id: 16, productId: 100, productCode: 'SKU', description: 'Prueba', quantity: 4.5, pieces: '', warehouse: '05' }],
};
const nativePiece: NativeReceiptPiece = {
  id: 91, productId: 100, productCode: 'SKU', serialNumber: 'native-serial', pieces: 1, quantity: 1,
  warehouse: '01', orderNumber: '', reference: '', date: '2025-01-01', receiptNumber: 'RA09214', invoiceNumber: '',
  customsEntry: '', importDate: null, customsOffice: '', notes: '',
};
const nativeSource = {
  receipt: vi.fn(async (_company: number, id: number) => id === nativeReceipt.id ? nativeReceipt : null),
  pieces: vi.fn(async () => [nativePiece]),
  serialExists: vi.fn(async (serial: string, ignored?: number) => serial === nativePiece.serialNumber && ignored !== nativePiece.id),
  sequence: vi.fn(async () => 2),
};
const store = new PostgresPurchaseReceptionPieces(nativeSource, async () => client, () => true);
const revision = async (receiptId = 151, lineId = 16) => (await store.line(1, receiptId, lineId))!.revision;

beforeAll(async () => {
  await db.exec(`
    CREATE SCHEMA tuvansa;
    CREATE TABLE tuvansa.purchase_receptions (id bigint, company_id int, number text, result jsonb, movement jsonb);
    CREATE TABLE tuvansa.purchase_reception_cancellations (company_id int, receipt_id bigint, legacy_receipt_id bigint);
    CREATE TABLE tuvansa.purchase_order_pieces (items jsonb);
    INSERT INTO tuvansa.purchase_order_pieces VALUES ('[{"serial":"from-order"}]');
  `);
  await db.query(
    'INSERT INTO tuvansa.purchase_receptions VALUES ($1,1,$2,$3::jsonb,$4::jsonb)',
    [localId, 'RW00000001', JSON.stringify({ reception: {
      id: localId, number: 'RW00000001', warehouse: '01', cancelled: false, dates: { receivedAt: '2025-01-01' },
      lines: [{ ...nativeReceipt.lines[0], id: 28, invoicedQuantity: 4.5, quantity: 5 }],
    } }), JSON.stringify({ header: { type: 'RA', inventoryFlag: 1 }, lines: [{ id: 28, warehouse: '10' }] })],
  );
}, 15000);

afterAll(async () => { await db.close(); });

describe('Recepciones → Alta Piezas y Edita pzas', () => {
  it('saves the exact native line as a web overlay and updates quantity and serial atomically', async () => {
    const before = await store.line(1, 151, 16);
    expect(before).toMatchObject({ remaining: 4.5, canAdd: true, canEdit: true, suggestedSerial: 'A00003' });
    expect(before?.revision).toMatch(/^[a-f0-9]{64}$/);
    const add = { serial: '', quantity: 1.25, reference: 'REF', revision: before!.revision, requestKey: '935bba45-5139-4abf-9e51-0f6f19bba163' };
    nativeReceipt.version = 'updated before submission';
    await expect(store.add(1, 151, 16, add)).rejects.toThrow('cambiaron');
    nativeReceipt.version = 'base';
    await expect(store.add(1, 151, 16, add)).resolves.toEqual({ serialNumber: 'A00003' });
    await expect(store.add(1, 151, 16, add)).resolves.toEqual({ serialNumber: 'A00003' });
    await expect(store.add(1, 151, 16, { ...add, quantity: 2 })).rejects.toThrow('La solicitud ya se usó');
    const { rows } = await db.query<{ piece: NativeReceiptPiece }>('SELECT piece FROM tuvansa.purchase_reception_pieces WHERE receipt_id=151');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.piece).toMatchObject({ serialNumber: 'A00003', productId: 100, quantity: 1.25, warehouse: '05', customsEntry: 'TEST' });
    await expect(store.line(1, 151, 16)).resolves.toMatchObject({ pieces: '1.25', remaining: 3.25, suggestedSerial: 'A00004' });
    await expect(store.edit(1, 151, 16, { pieces: 'nota original', revision: add.revision })).rejects.toThrow('cambiaron');
    await expect(store.edit(1, 151, 16, { pieces: 'nota original', revision: await revision() })).resolves.toEqual({ pieces: 'nota original' });
    await expect(store.line(1, 151, 16)).resolves.toMatchObject({ canAdd: false, canEdit: true, pieces: 'nota original' });
    await expect(store.edit(1, 151, 16, { pieces: '', revision: await revision() })).resolves.toEqual({ pieces: '' });
    await expect(store.line(1, 151, 16)).resolves.toMatchObject({ remaining: 3.25 });
    expect(await purchaseReceptionPieceProducts([100, 200], client)).toEqual(new Set([100]));
  });

  it('locates local RW and native pieces by their exact identities and protects duplicates', async () => {
    await expect(store.line(1, localId, 28)).resolves.toMatchObject({ remaining: 4.5, canAdd: true });
    const add = { serial: 'from-order', quantity: 2.5, reference: '', revision: await revision(localId, 28), requestKey: '4126590d-2cf3-469b-82fa-ea0e76e0b10c' };
    await expect(store.add(1, localId, 28, add)).rejects.toThrow('duplicado');
    await expect(store.add(1, localId, 28, { ...add, serial: 'native-serial' })).rejects.toThrow('duplicado');
    await expect(store.add(1, localId, 28, { ...add, serial: 'local-serial' })).resolves.toEqual({ serialNumber: 'local-serial' });
    await expect(store.add(1, 151, 16, { ...add, revision: await revision(), serial: 'local-serial', quantity: 1,
      requestKey: 'edd1842a-2554-42f5-81ba-0055bc38ca73',
    })).rejects.toThrow('duplicado');
    const { rows: [item] } = await db.query<{ piece: NativeReceiptPiece }>('SELECT piece FROM tuvansa.purchase_reception_pieces WHERE receipt_id=$1', [localId]);
    expect(item?.piece).toMatchObject({ warehouse: '10' });
    await expect(store.updateSerial(1, localId, 91, { serial: 'bogus', previousSerial: 'native-serial' })).rejects.toThrow('Pieza de recepción');
    await expect(store.updateSerial(1, 151, 91, { serial: 'local-serial', previousSerial: 'native-serial' })).rejects.toThrow('duplicado');
    await expect(store.updateSerial(1, 151, 91, { serial: 'renamed-native', previousSerial: 'native-serial' }))
      .resolves.toEqual({ serialNumber: 'renamed-native' });
    await expect(store.updateSerial(1, 151, 91, { serial: 'bad', previousSerial: 'native-serial' })).rejects.toThrow('cambiaron');
    await expect(store.updateSerial(1, localId, item!.piece.id, { serial: 'renamed-local', previousSerial: 'local-serial' }))
      .resolves.toEqual({ serialNumber: 'renamed-local' });
  });

  it('retirement under the cancellation lock disables all writes and retains the controls-pieces flag', async () => {
    await store.add(1, 151, 16, {
      serial: 'pre-cancel', quantity: 1, reference: '', revision: await revision(), requestKey: 'edfc813d-e522-43ba-9ae6-88feaf2effe9',
    });
    await client.query('BEGIN');
    try {
      await lockPurchaseReceptionPieces(client, 1, 151);
      await client.query('INSERT INTO tuvansa.purchase_reception_cancellations VALUES (1,NULL,151)');
      await retirePurchaseReceptionPieces(client, 1, 151);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
    const { rows: [{ count }] } = await db.query<{ count: number }>('SELECT count(*)::int FROM tuvansa.purchase_reception_pieces WHERE receipt_id=151 AND NOT retired');
    expect(count).toBe(0);
    await expect(store.line(1, 151, 16)).resolves.toMatchObject({ canAdd: false, canEdit: false, addReason: 'La recepción ya fue cancelada.' });
    await expect(store.updateSerial(1, 151, 91, { serial: 'bad', previousSerial: 'renamed-native' })).rejects.toThrow('cancelada');
    expect(await purchaseReceptionPieceProducts([100], client)).toEqual(new Set([100]));
  });
});
