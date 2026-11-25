import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMovementsModule } from '../src/modules/inventories/movements/movements-module.js';
import { LegacyMysqlMovementsDataSource } from '../src/modules/inventories/movements/infrastructure/datasources/legacy-mysql-movements-data-source.js';
import { errorHandler } from '../src/shared/infrastructure/http/error-handler.js';

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('../src/shared/infrastructure/database/legacy-mysql-pool.js', () => ({
  legacyMysqlPool: { execute },
}));

const header = {
  id: 125,
  document: 'EI1000',
  date: '2019-08-27',
  reference: 'CAMBIO DE M',
  reference2: '',
  warehouse: '01',
  supplierCode: '',
  customerCode: '',
  customerName: '',
  type: 'EI',
  status: 0,
  company: 1,
  userId: 66,
  inventoryFlag: 1,
  billingFlag: 0,
};

const line = {
  id: 91,
  productId: 95,
  productCode: '01300935',
  description: 'TUBO DE ACERO',
  quantity: 2,
  unit: 'PZ',
  cost: 5777.085,
  pieces: 0,
  piecesText: '',
  warehouse: '01',
  type: 'EI',
  lotId: 0,
  userId: 66,
};

const app = express().use('/api/inventories/movements', createMovementsModule()).use(errorHandler);

beforeEach(() => execute.mockReset());

describe('inventory movement lookup', () => {
  it('applies filters to both the result and count with stable pagination', async () => {
    execute.mockResolvedValueOnce([[header]]).mockResolvedValueOnce([[{ total: 27 }]]);
    const response = await request(app).get('/api/inventories/movements').query({
      document: 'EI10',
      date: '2019-08-27',
      reference: 'CAMBIO%_!',
      reference2: 'REF2',
      warehouse: '01',
      supplier: 'PR',
      customer: 'CL',
      page: 2,
      pageSize: 10,
    });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: [header], pagination: { page: 2, pageSize: 10, total: 27 } });
    const params = ['EI10%', 'CAMBIO!%!_!!%', 'REF2%', '01%', 'PR%', 'CL%', '2019-08-27'];
    expect(execute.mock.calls[0]?.[1]).toEqual([...params, 10, 10]);
    expect(execute.mock.calls[1]?.[1]).toEqual([...params, 1000]);
    for (const [sql] of execute.mock.calls) {
      expect(sql).toContain('WHERE FDOC.DESINV = 1');
      expect(sql).not.toContain('FDOC.DEST =');
      expect(sql).not.toContain('FDOC.DMULTICIA =');
      expect(sql).toContain('FDOC.DFECHA = ?');
      expect(sql).not.toContain('CAMBIO');
    }
    expect(execute.mock.calls[0]?.[0]).toContain('ORDER BY FDOC.DFECHA, FDOC.DSEQ');
  });

  it('returns an empty start without accessing MySQL until a filter is supplied', async () => {
    const response = await request(app).get('/api/inventories/movements');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: [], pagination: { page: 1, pageSize: 25, total: 0 } });
    expect(execute).not.toHaveBeenCalled();
  });

  it('chooses the first active reference sort and caps retrieval at 1000 documents', async () => {
    execute.mockResolvedValueOnce([[]]).mockResolvedValueOnce([[{ total: 1000 }]]);
    const response = await request(app).get('/api/inventories/movements').query({
      document: 'EI',
      reference: 'CAMBIO',
      reference2: 'SECUNDARIA',
      page: 39,
      pageSize: 26,
    });
    expect(response.status).toBe(200);
    expect(response.body.pagination.total).toBe(1000);
    expect(execute.mock.calls[0]).toEqual([
      expect.stringContaining('ORDER BY FDOC.DREFER, FDOC.DSEQ'),
      ['EI%', 'CAMBIO%', 'SECUNDARIA%', 12, 988],
    ]);
  });

  it('loads the selected document by its id and keeps the details in movement sequence', async () => {
    execute.mockResolvedValueOnce([[{ ...header, comment: ' Ajuste de inventario ' }]]).mockResolvedValueOnce([[line]]);
    const response = await request(app).get('/api/inventories/movements/125');
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      header,
      lines: [line],
      totals: { quantity: 2, cost: 11554.17 },
      comment: 'Ajuste de inventario',
      cancellationAvailable: false,
    });
    expect(response.body.data.header).not.toHaveProperty('comment');
    expect(execute.mock.calls[0]?.[0]).toContain('FCOMENT.COMSEQFACT = FDOC.DSEQ');
    expect(execute.mock.calls[0]).toEqual([
      expect.stringContaining('WHERE FDOC.DSEQ = ? LIMIT 1'),
      [125],
    ]);
    expect(execute.mock.calls[1]).toEqual([
      expect.stringContaining('WHERE FAXINV.DSEQ = ? ORDER BY FAXINV.AISEQ'),
      [125],
    ]);
  });

  it('binds one historical supplier change as typed literals in the movement detail query', async () => {
    const receipt = { ...header, id: 343646, document: 'RA09214', type: 'RA', supplierCode: '35436' };
    const source = new LegacyMysqlMovementsDataSource();
    execute.mockResolvedValueOnce([[receipt]]).mockResolvedValueOnce([[line]]);
    const result = await source.findById(receipt.id, [{
      receiptId: receipt.id, receiptNumber: receipt.document, originalSupplierId: 35,
      supplier: { id: 36, code: receipt.supplierCode, name: 'Proveedor nuevo' },
      amount: 100, supplierAccount: '2005', historical: true, charge: null, revision: 1,
    }]);

    expect(result).toMatchObject({ header: receipt, lines: [line] });
    expect(execute.mock.calls[0]).toEqual([
      expect.stringContaining('CAST(? AS CHAR CHARACTER SET utf8) AS supplier_code'),
      [receipt.id, receipt.document, 35, 36, receipt.supplierCode, 'Proveedor nuevo', receipt.id],
    ]);
    expect(execute.mock.calls[0]?.[0]).toContain('receipt_supplier.original_supplier_id=FDOC.PRVSEQ');
  });

  it('returns 404 for an absent document without querying its details', async () => {
    execute.mockResolvedValueOnce([[]]);
    expect((await request(app).get('/api/inventories/movements/125')).status).toBe(404);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed dates and ids before reaching the datasource', async () => {
    expect((await request(app).get('/api/inventories/movements?date=2019-02-30')).status).toBe(400);
    expect((await request(app).get('/api/inventories/movements/0')).status).toBe(400);
    expect(execute).not.toHaveBeenCalled();
  });
});

describe('inventory movement printing', () => {
  const settings = {
    format: 'QTUVANSA007', adHoc: 0, companyName: 'TUVANSA', city: 'México', state: 'CDMX', warehouseName: 'Almacén central',
  };

  it('prepares the selected EI using the effective type format and the ordered movement lines', async () => {
    execute.mockResolvedValueOnce([[{ ...header, comment: ' Ajuste de inventario ' }]])
      .mockResolvedValueOnce([[line]])
      .mockResolvedValueOnce([[settings]]);

    const response = await request(app).get('/api/inventories/movements/125/actions/print');
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      format: 'QTUVANSA007', type: 'EI', document: 'EI1000', date: '2019-08-27',
      warehouse: '01', warehouseName: 'Almacén central', place: 'México, CDMX',
      comment: 'Ajuste de inventario',
      lines: [{ id: 91, productCode: line.productCode, quantity: 2, cost: 5777.085, amount: 11554.17, customs: null }],
      total: 11554.17,
    });
    expect(execute.mock.calls[2]).toEqual([
      expect.stringContaining('ORDER BY t.TIMULTICIA DESC,t.TISEQ LIMIT 1'),
      ['01', 'EI', 1],
    ]);
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it('prepares the signed SI and reads the customs data only for its linked lot', async () => {
    execute.mockResolvedValueOnce([[{ ...header, document: 'SI1148', type: 'SI' }]])
      .mockResolvedValueOnce([[{ ...line, quantity: -2, type: 'SI', lotId: 73 }]])
      .mockResolvedValueOnce([[{ ...settings, format: 'QTUVANSA002' }]])
      .mockResolvedValueOnce([[{ id: 73, entry: 'PEDIMENTO PRUEBA', date: '2019-08-01', office: 'ADUANA' }]]);

    const response = await request(app).get('/api/inventories/movements/125/actions/print');
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      format: 'QTUVANSA002', type: 'SI', document: 'SI1148',
      lines: [{ quantity: -2, amount: -11554.17, customs: { entry: 'PEDIMENTO PRUEBA', date: '2019-08-01', office: 'ADUANA' } }],
      total: -11554.17,
    });
    expect(execute.mock.calls[3]).toEqual([expect.stringContaining('FROM FLOTES WHERE LOSEQ IN (?)'), [73]]);
  });

  it('prints both sides of a TR in movement sequence with their warehouses and signed amounts', async () => {
    execute.mockResolvedValueOnce([[{ ...header, document: 'TR0004', type: 'TR', reference2: '13' }]])
      .mockResolvedValueOnce([[
        { ...line, id: 216664, type: 'TR', warehouse: '13', quantity: -12.38, cost: 2561.0244 },
        { ...line, id: 216665, type: 'TR', warehouse: '01', quantity: 12.38, cost: 2561.0244 },
        { ...line, id: 216666, type: 'TR', warehouse: '13', quantity: -1513.8, cost: 187.3844 },
        { ...line, id: 216667, type: 'TR', warehouse: '01', quantity: 1513.8, cost: 187.3844 },
      ]])
      .mockResolvedValueOnce([[settings]]);

    const response = await request(app).get('/api/inventories/movements/125/actions/print');
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      format: 'QTUVANSA007', type: 'TR', document: 'TR0004', warehouse: '01', sourceWarehouse: '13',
      lines: [
        { id: 216664, warehouse: '13', quantity: -12.38, amount: -12.38 * 2561.0244 },
        { id: 216665, warehouse: '01', quantity: 12.38, amount: 12.38 * 2561.0244 },
        { id: 216666, warehouse: '13', quantity: -1513.8, amount: -1513.8 * 187.3844 },
        { id: 216667, warehouse: '01', quantity: 1513.8, amount: 1513.8 * 187.3844 },
      ],
      total: 0,
    });
    expect(execute.mock.calls[2]?.[1]).toEqual(['01', 'TR', 1]);
  });

  it.each([
    { document: 'RA09214', type: 'RA' },
    { company: 2 },
    { status: 1 },
  ])('rejects a document outside the verified print scope before reading its format', async (changes) => {
    execute.mockResolvedValueOnce([[{ ...header, ...changes }]]).mockResolvedValueOnce([[line]]);
    const response = await request(app).get('/api/inventories/movements/125/actions/print');
    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('INVENTORY_MOVEMENT_PRINT_UNAVAILABLE');
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('rejects a cancelled document and an unsupported layout', async () => {
    const transfer = { ...header, document: 'TR0005', type: 'TR' };
    execute.mockResolvedValueOnce([[transfer]])
      .mockResolvedValueOnce([[{ ...line, type: 'K', quantity: 0, cost: 0 }]])
      .mockResolvedValueOnce([[transfer]])
      .mockResolvedValueOnce([[{ ...line, type: 'TR' }]])
      .mockResolvedValueOnce([[{ ...settings, format: 'QTUVANSA002' }]]);
    const cancelled = await request(app).get('/api/inventories/movements/125/actions/print');
    expect(cancelled.status).toBe(422);
    expect(cancelled.body.error.code).toBe('INVENTORY_MOVEMENT_PRINT_UNAVAILABLE');
    expect(execute).toHaveBeenCalledTimes(2);
    const otherFormat = await request(app).get('/api/inventories/movements/125/actions/print');
    expect(otherFormat.status).toBe(422);
    expect(otherFormat.body.error.code).toBe('INVENTORY_MOVEMENT_PRINT_UNAVAILABLE');
    expect(execute).toHaveBeenCalledTimes(5);
  });
});
