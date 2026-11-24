import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { LegacyMysqlPurchaseReceptionsDataSource } from '../src/modules/purchasing/purchase-receptions/infrastructure/datasources/legacy-mysql-purchase-receptions-data-source.js';
import { MysqlPurchaseReceptionPieceNativeSource } from '../src/modules/purchasing/purchase-receptions/infrastructure/datasources/mysql-purchase-reception-piece-native-source.js';

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('../src/shared/infrastructure/database/legacy-mysql-pool.js', () => ({ legacyMysqlPool: { execute } }));

const db = new PGlite();
const dataSource = new LegacyMysqlPurchaseReceptionsDataSource();

beforeAll(async () => {
  await db.exec(`
    CREATE TABLE FDOC (DSEQ int PRIMARY KEY, DNUM text, DEST int, DMULTICIA int, DESFACT int, DESCXC int);
    CREATE TABLE FPENC (PESEQ int PRIMARY KEY, PENUM text, PEMULTICIA int, PESPEDIDO int);
    CREATE TABLE FINV (ISEQ int PRIMARY KEY, ICOD text);
    CREATE TABLE FCAJAS (
      CAJSEQ int PRIMARY KEY, ISEQ int, CAJSERIE text, CAJPZAS decimal(18, 0), CAJCANT decimal(18, 3),
      CAJALM text, CAJPEDIDO text, CAJREFER text, CAJFECHA text, CAJRECEPCION text, CAJFACTURA text,
      CAJPEDIMENTO text, CAJFECHAIMPORT text, CAJADUANA text, CAJOBS text
    );
    INSERT INTO FDOC VALUES
      (7, 'RA1', 0, 1, 2, 2), (8, 'RA2', 0, 1, 2, 2), (9, 'RA2', 0, 2, 2, 2),
      (10, 'RA3', 0, 1, 2, 2), (11, 'RA1', 1, 1, 0, 0);
    INSERT INTO FINV VALUES (99, 'PRODUCTO');
    INSERT INTO FPENC VALUES
      (31, 'OC00001', 1, 2), (32, 'OC00002', 1, 2), (33, 'OC00002', 2, 2),
      (34, 'OC00003', 1, 5);
    INSERT INTO FCAJAS VALUES
      (17, 98, 'SN-2', 1, 25, '01', '', '', '2025-01-10', 'RA1', '', '', '1900-12-31', '', ''),
      (15, 99, 'SN-1', 2, 4.5, '05', 'OA7', 'REF', '2025-01-09', 'RA1', 'FA8', '800', '2025-01-01', '430', 'Nota'),
      (16, 99, 'OTRO', 1, 20, '01', 'OA7', 'REF', '2025-01-09', 'RA2', 'RA1', '', '1900-12-31', '', ''),
      (31, 99, 'SN-OC', 1, 2.5, '06', '', 'REF', '2025-01-09', 'OC00001', 'OC00001', '800', '2025-01-01', '430', 'Nota'),
      (32, 99, 'SN-RECEP', 1, 1, '06', '', '', '2025-01-09', 'OC00001', 'OC00002', '', '1900-12-31', '', ''),
      (33, 99, 'SN-FACT', 1, 1, '06', '', '', '2025-01-09', 'OC00002', 'OC00001', '', '1900-12-31', '', ''),
      (34, 99, 'SN-DUP', 1, 1, '06', '', '', '2025-01-09', 'OC00002', 'OC00002', '', '1900-12-31', '', ''),
      (35, 99, 'SN-COT', 1, 1, '06', '', '', '2025-01-09', 'OC00003', 'OC00003', '', '1900-12-31', '', '');
  `);
  execute.mockImplementation(async (sql: string, parameters: unknown[]) => {
    let index = 0;
    const query = sql.replaceAll('?', () => '$' + ++index).replace(/\bAS ([A-Za-z]+)\b/g, 'AS "$1"');
    return [(await db.query(query, parameters)).rows];
  });
}, 15000);

afterAll(async () => {
  await db.close();
});

describe('Recepciones → Piezas', () => {
  it('reads the exact receipt association and preserves the piece fields even without a current product', async () => {
    const result = await dataSource.getPanel(7, 'pieces');
    expect(result).toEqual({
      purchaseReception: { id: 7, number: 'RA1' }, key: 'pieces', section: 'actions', button: 'Piezas', source: 'mysql',
      items: [
        {
          id: 15, productId: 99, productCode: 'PRODUCTO', serialNumber: 'SN-1', pieces: 2, quantity: 4.5,
          warehouse: '05', orderNumber: 'OA7', reference: 'REF', date: '2025-01-09', receiptNumber: 'RA1',
          invoiceNumber: 'FA8', customsEntry: '800', importDate: '2025-01-01', customsOffice: '430', notes: 'Nota',
        },
        {
          id: 17, productId: 98, productCode: '', serialNumber: 'SN-2', pieces: 1, quantity: 25, warehouse: '01',
          orderNumber: '', reference: '', date: '2025-01-10', receiptNumber: 'RA1', invoiceNumber: '',
          customsEntry: '', importDate: null, customsOffice: '', notes: '',
        },
      ],
    });
  });

  it('withholds ambiguous folios across companies and handles empty and inaccessible receipts', async () => {
    await expect(dataSource.getPanel(8, 'pieces')).resolves.toMatchObject({ items: [] });
    await expect(dataSource.getPanel(10, 'pieces')).resolves.toMatchObject({ items: [] });
    await expect(dataSource.getPanel(9, 'pieces')).resolves.toBeNull();
    await expect(dataSource.getPanel(404, 'pieces')).resolves.toBeNull();
  });

  it('loads only pieces bound through both native references to the exact purchase order', async () => {
    const source = new MysqlPurchaseReceptionPieceNativeSource();
    await expect(source.orderPieces(1, { id: 31, number: 'OC00001' })).resolves.toEqual([{
      id: 31, productId: 99, productCode: 'PRODUCTO', serialNumber: 'SN-OC', pieces: 1, quantity: 2.5,
      warehouse: '06', orderNumber: '', reference: 'REF', date: '2025-01-09', receiptNumber: 'OC00001',
      invoiceNumber: 'OC00001', customsEntry: '800', importDate: '2025-01-01', customsOffice: '430', notes: 'Nota',
    }]);
    await expect(source.orderPieces(1, { id: 31, number: 'OC00002' })).resolves.toEqual([]);
    await expect(source.orderPieces(1, { id: 32, number: 'OC00002' })).rejects.toMatchObject({ code: 'PURCHASE_RECEPTION_PIECE_ORDER_AMBIGUOUS' });
    await expect(source.orderPieces(1, { id: 33, number: 'OC00002' })).resolves.toEqual([]);
    await expect(source.orderPieces(1, { id: 34, number: 'OC00003' })).resolves.toEqual([]);
  });
});
