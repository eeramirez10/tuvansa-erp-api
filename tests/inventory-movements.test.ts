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
