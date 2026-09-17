import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CaptureOrder } from '../src/modules/sales/orders/application/use-cases/capture-order.js';
import { amountInWords, captureTotals } from '../src/modules/sales/orders/domain/entities/order-capture-totals.js';
import type { CaptureInput, CaptureProduct, OrderCaptureRepository } from '../src/modules/sales/orders/domain/repositories/order-capture-repository.js';
import { createOrderCaptureRouter, captureInputSchema } from '../src/modules/sales/orders/presentation/http/order-capture-router.js';
import { errorHandler } from '../src/shared/infrastructure/http/error-handler.js';

const pool = vi.hoisted(() => ({ getConnection: vi.fn(), execute: vi.fn() }));
vi.mock('../src/shared/infrastructure/database/legacy-mysql-pool.js', () => ({ legacyMysqlPool: pool }));
import { LegacyMysqlOrderCaptureDataSource } from '../src/modules/sales/orders/infrastructure/datasources/legacy-mysql-order-capture-data-source.js';
import { LegacyMysqlOrdersDataSource } from '../src/modules/sales/orders/infrastructure/datasources/legacy-mysql-orders-data-source.js';
import { Order } from '../src/modules/sales/orders/domain/entities/order.js';

const input: CaptureInput = {
  warehouse: '01', typeCode: 'P', customerCode: '000001', customerOrderNumber: 'TEST',
  orderedAt: '2026-09-14', from: '2026-09-14', dueAt: '2026-09-14', department: '', initial: false,
  agentCode: '1202', termsDays: 30, store: '302', observations: '', documentKind: 'quote',
  lines: [{ productCode: '01300958', quantity: 1, price: 59.05, discount: 0 }],
};
const product: CaptureProduct = {
  id: 13288, code: '01300958', description: 'TEST', unit: 'M', price: 59.05, cost: 40, taxPercentage: 16,
  excisePercentage: 0, currencyId: 2, stock: 5, assigned: 1, available: 4, weight: 16.08, volume: 0,
};
const repository = (): OrderCaptureRepository => ({
  options: vi.fn().mockResolvedValue({ warehouses: [], types: [] }),
  customer: vi.fn(), searchCustomers: vi.fn(), product: vi.fn(), create: vi.fn(), convertQuote: vi.fn(),
  setAuthorization: vi.fn(), setAssignment: vi.fn(),
});
const app = (repo: OrderCaptureRepository) => express().use(express.json()).use(createOrderCaptureRouter(new CaptureOrder(repo))).use(errorHandler);
afterEach(() => { vi.clearAllMocks(); vi.restoreAllMocks(); });

describe('Alta de pedidos capturada', () => {
  it('reproduce los importes de 01300958 y admite múltiples partidas con descuento', () => {
    expect(captureTotals([{ input: input.lines[0]!, product }])).toMatchObject({ subtotal: 59.05, tax: 9.45, total: 68.5, quantity: 1 });
    const totals = captureTotals([
      { input: { ...input.lines[0]!, quantity: 2, discount: 10 }, product },
      { input: input.lines[0]!, product },
    ]);
    expect(totals).toMatchObject({ quantity: 3, subtotal: 177.15, discount: 11.81, tax: 26.45, total: 191.79 });
    expect(amountInWords(68.5)).toBe('SESENTA Y OCHO 50/100');
    expect(amountInWords(999.999)).toBe('MIL 00/100');
  });
  it('valida fechas reales, cantidades, campos desconocidos y evita folios del cliente HTTP', () => {
    expect(captureInputSchema.safeParse(input).success).toBe(true);
    for (const invalid of [ { ...input, orderedAt: '2026-02-30' }, { ...input, number: 'P999999' },
      { ...input, from: '2026-09-15' }, { ...input, lines: [] },
      { ...input, lines: [{ ...input.lines[0], quantity: 0 }] },
      { ...input, lines: [{ ...input.lines[0], price: Number.NaN }] } ]) {
      expect(captureInputSchema.safeParse(invalid).success).toBe(false);
    }
  });
  it('responde 400 antes de acceder al origen y expone opciones estáticas', async () => {
    const repo = repository();
    await request(app(repo)).post('/capture').send({ ...input, warehouse: '' }).expect(400);
    expect(repo.create).not.toHaveBeenCalled();
    await request(app(repo)).get('/capture/options').expect(200, { data: { warehouses: [], types: [] } });
    await request(app(repo)).get('/capture/products/01300958?warehouse=01&typeCode=INVALID').expect(400);
    expect(repo.product).not.toHaveBeenCalled();
  });
  it('busca coincidencias por código, nombre y RFC con filtros parametrizados', async () => {
    const repo = repository();
    vi.mocked(repo.searchCustomers).mockResolvedValue([]);
    await request(app(repo)).get('/capture/customers?code=000&name=ACERO&taxId=TUV&limit=25').expect(200, { data: [] });
    expect(repo.searchCustomers).toHaveBeenCalledWith({ code: '000', name: 'ACERO', taxId: 'TUV' }, 25);
    await request(app(repo)).get('/capture/customers').expect(400);

    pool.execute.mockResolvedValueOnce([[]]);
    await new LegacyMysqlOrderCaptureDataSource().searchCustomers({ code: '000', name: 'ACERO', taxId: 'TUV' }, 25);
    expect(pool.execute.mock.calls[0]?.[1]).toEqual(['000', '000', '000', 'ACERO', 'ACERO', 'TUV', 'TUV', 25]);
  });
  it('rechaza tablas no transaccionales sin iniciar escrituras', async () => {
    const c = { execute: vi.fn().mockResolvedValue([[{engine:'MyISAM'}]]), beginTransaction: vi.fn(), rollback: vi.fn(), release: vi.fn(), commit: vi.fn() };
    pool.getConnection.mockResolvedValue(c);
    await expect(new LegacyMysqlOrderCaptureDataSource().create(input)).rejects.toMatchObject({ code: 'ORDER_CAPTURE_CONFLICT' });
    expect(c.beginTransaction).not.toHaveBeenCalled(); expect(c.commit).not.toHaveBeenCalled(); expect(c.release).toHaveBeenCalled();
  });
  it('bloquea folio y revierte la transacción ante una colisión, sin insertar encabezado', async () => {
    const c = { execute: vi.fn().mockResolvedValueOnce([Array.from({length:7},()=>({engine:'InnoDB'}))])
      .mockResolvedValueOnce([[{id:2,code:'P',counter:21063,width:7}]])
      .mockResolvedValueOnce([[{id:123}]]), beginTransaction: vi.fn(), rollback: vi.fn(), release: vi.fn(), commit: vi.fn() };
    pool.getConnection.mockResolvedValue(c);
    await expect(new LegacyMysqlOrderCaptureDataSource().create(input)).rejects.toMatchObject({ code: 'ORDER_CAPTURE_CONFLICT' });
    expect(c.execute.mock.calls[1]?.[0]).toContain('FOR UPDATE');
    expect(c.execute.mock.calls.every(([sql]) => !String(sql).startsWith('INSERT'))).toBe(true);
    expect(c.rollback).toHaveBeenCalledOnce(); expect(c.commit).not.toHaveBeenCalled(); expect(c.release).toHaveBeenCalledOnce();
  });
  it('resuelve el código de IVA 0 usando TIIVA0=16, no como exención', async () => {
    pool.execute.mockResolvedValueOnce([[{code:'01'}]])
      .mockResolvedValueOnce([[{id:2,code:'P',tax0:16,tax1:0,tax2:0}]])
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[{...product,taxCode:0}]])
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[{stock:5,assigned:1,cost:40}]]);
    await expect(new LegacyMysqlOrderCaptureDataSource().product('01300958','01','P','000001')).resolves.toMatchObject({ taxPercentage:16,available:4 });
    expect(pool.execute.mock.calls[5]?.[1]).toEqual(['01300958     01']);
  });
  it('resuelve IEAN sin distinguir mayúsculas y continúa con el ICOD canónico', async () => {
    const eanProduct = { ...product, id:13268, code:'01300938' };
    pool.execute.mockResolvedValueOnce([[{code:'01'}]])
      .mockResolvedValueOnce([[{id:2,code:'P',tax0:16,tax1:0,tax2:0}]])
      .mockResolvedValueOnce([[{code:'01300938'}]])
      .mockResolvedValueOnce([[{...eanProduct,taxCode:0}]])
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[{stock:5,assigned:1,cost:40}]]);
    await expect(new LegacyMysqlOrderCaptureDataSource().product('tsc480','01','P','000001')).resolves.toMatchObject({ id:13268,code:'01300938' });
    expect(pool.execute.mock.calls[2]?.[0]).toContain('FALM.ALMNUM=?');
    expect(pool.execute.mock.calls[2]?.[1]).toEqual(['tsc480','01']);
    expect(pool.execute.mock.calls[3]?.[1]).toEqual(['01300938']);
  });
  it('limita la captura actual al almacén 01 México', async () => {
    await expect(new LegacyMysqlOrderCaptureDataSource().product('tsc480','02','P','000001'))
      .rejects.toMatchObject({ code:'ORDER_CAPTURE_CONFLICT' });
    expect(pool.execute).not.toHaveBeenCalled();
  });
  it('no convierte cotizaciones surtidas ni asignadas', async () => {
    const c = { execute: vi.fn().mockResolvedValueOnce([Array.from({length:7},()=>({engine:'InnoDB'}))])
      .mockResolvedValueOnce([[{kind:4,warehouse:'01',authorized:0}]])
      .mockResolvedValueOnce([[{productId:13288,code:'01300958',quantity:1,fulfilled:0,assigned:1}]]),
      beginTransaction: vi.fn(), rollback: vi.fn(), release: vi.fn(), commit: vi.fn() };
    pool.getConnection.mockResolvedValue(c);
    await expect(new LegacyMysqlOrderCaptureDataSource().convertQuote(42)).rejects.toMatchObject({ code:'ORDER_CAPTURE_CONFLICT' });
    expect(c.execute.mock.calls.every(([sql])=>!String(sql).startsWith('UPDATE'))).toBe(true);
    expect(c.rollback).toHaveBeenCalledOnce();
  });
  it('revierte encabezado y acumulados si falla una partida; nunca confirma un alta parcial', async () => {
    const execute = vi.fn(async (sql: string) => {
      if (sql.includes('information_schema')) return [Array.from({length:7},()=>({engine:'InnoDB'}))];
      if (sql.includes('FROM FTIPMV')) return [[{id:2,code:'P',counter:21063,width:7,tax0:16,tax1:0,tax2:0}]];
      if (sql.startsWith('SELECT PESEQ')) return [[]];
      if (sql.includes('FROM FALMCAT')) return [[{code:'01'}]];
      if (sql.includes('FROM FCLI')) return [[{id:15331,code:'000001',termsDays:30,classification:'211'}]];
      if (sql.includes('FROM FSUCURSALES')) return [[]];
      if (sql.includes('FROM FAG')) return [[{code:'1202'}]];
      if (sql.includes('FROM FINV')) return [[{...product,taxCode:0}]];
      if (sql.includes('FROM FDESCTOS')) return [[]];
      if (sql.includes('FROM FALM')) return [[{stock:5,assigned:1}]];
      if (sql.startsWith('INSERT INTO FPENC')) return [{insertId:204820}];
      if (sql.includes('INSERT INTO FPLIN')) throw new Error('Simulated line failure');
      return [{affectedRows:1}];
    });
    const c = { execute, beginTransaction:vi.fn(),rollback:vi.fn(),release:vi.fn(),commit:vi.fn() };
    pool.getConnection.mockResolvedValue(c);
    await expect(new LegacyMysqlOrderCaptureDataSource().create(input)).rejects.toThrow('Simulated line failure');
    expect(execute.mock.calls.some(([sql])=>sql.startsWith('INSERT INTO FPENC'))).toBe(true);
    expect(execute.mock.calls.some(([sql])=>sql.startsWith('UPDATE FALM'))).toBe(true);
    expect(c.rollback).toHaveBeenCalledOnce(); expect(c.commit).not.toHaveBeenCalled(); expect(c.release).toHaveBeenCalledOnce();
  });
  it('informa permisos insuficientes sin exponer datos de la conexión', async () => {
    const c = { execute:vi.fn().mockResolvedValueOnce([Array.from({length:7},()=>({engine:'InnoDB'}))])
      .mockRejectedValueOnce({code:'ER_TABLEACCESS_DENIED_ERROR',sqlMessage:'private connection details'}),
      beginTransaction:vi.fn(),rollback:vi.fn(),release:vi.fn(),commit:vi.fn() };
    pool.getConnection.mockResolvedValue(c);
    await expect(new LegacyMysqlOrderCaptureDataSource().create(input)).rejects.toMatchObject({code:'ORDER_CAPTURE_WRITE_UNAVAILABLE',statusCode:503});
    expect(c.commit).not.toHaveBeenCalled();
  });
  it('guarda todas las partidas, usa el vínculo nuevo y serializa el folio en una sola transacción', async () => {
    const saved = Order.create({
      id:204820,number:'P021064',customerOrderNumber:'TEST',customer:{id:15331,code:'000001',name:'TEST'},
      documentKind:'quote',status:'',fulfilledAmount:0,branch:0,department:'',dates:{orderedAt:'2026-09-14',from:'2026-09-14',dueAt:'2026-09-14'},
      attention:'',termsDays:30,authorization:'',initial:false,warehouse:'01',currencyId:0,exchangeRate:0,
      minimumFulfillmentPercentage:0,observations:'',classifications:[],
      totals:{quantity:2,ordered:2,fulfilled:0,remaining:2,subtotal:118.1,discount:0,freight:0,insurance:0,other:0,tax:18.9,total:137},lines:[],
    });
    const read = vi.spyOn(LegacyMysqlOrdersDataSource.prototype,'findById').mockResolvedValue(saved);
    const execute = vi.fn(async (sql: string, _params?: unknown) => {
      if (sql.includes('information_schema')) return [Array.from({length:7},()=>({engine:'InnoDB'}))];
      if (sql.includes('FROM FTIPMV')) return [[{id:2,code:'P',counter:21063,width:7,tax0:16,tax1:0,tax2:0}]];
      if (sql.startsWith('SELECT PESEQ')) return [[]];
      if (sql.includes('FROM FALMCAT')) return [[{code:'01'}]];
      if (sql.includes('FROM FCLI')) return [[{id:15331,code:'000001',termsDays:30,classification:'211'}]];
      if (sql.includes('FROM FSUCURSALES')) return [[]];
      if (sql.includes('FROM FAG')) return [[{code:'1202'}]];
      if (sql.includes('FROM FINV')) return [[{...product,taxCode:0}]];
      if (sql.includes('FROM FDESCTOS')) return [[]];
      if (sql.includes('FROM FALM')) return [[{stock:5,assigned:1}]];
      if (sql.startsWith('INSERT INTO FPENC')) return [{insertId:204820}];
      return [{affectedRows:1}];
    });
    const c = { execute,beginTransaction:vi.fn(),rollback:vi.fn(),release:vi.fn(),commit:vi.fn() };
    pool.getConnection.mockResolvedValue(c);
    await expect(new LegacyMysqlOrderCaptureDataSource().create({...input,lines:[...input.lines,...input.lines]})).resolves.toBe(saved);
    expect(execute.mock.calls.filter(([sql])=>sql.includes('INSERT INTO FPLIN'))).toHaveLength(2);
    expect(execute.mock.calls.find(([sql])=>sql.startsWith('INSERT INTO FCOMENT'))?.[1]).toEqual([1000204820,'P021064','CIENTO TREINTA Y SIETE 00/100']);
    expect(execute.mock.calls.filter(([sql])=>sql.startsWith('UPDATE FTIPMV'))).toHaveLength(1);
    expect(read).toHaveBeenCalledWith(204820,c);
    expect(read.mock.invocationCallOrder[0]).toBeLessThan(c.commit.mock.invocationCallOrder[0]!);
    expect(c.commit).toHaveBeenCalledOnce(); expect(c.rollback).not.toHaveBeenCalled();
    const converted = vi.spyOn(LegacyMysqlOrdersDataSource.prototype,'findById').mockResolvedValue(saved);
    execute.mockImplementation(async (sql: string) => {
      if (sql.includes('information_schema')) return [Array.from({length:7},()=>({engine:'InnoDB'}))];
      return [[{kind:1,warehouse:'01',authorized:0}]];
    });
    execute.mockClear();
    await new LegacyMysqlOrderCaptureDataSource().convertQuote(204820);
    expect(converted).toHaveBeenCalled();
    expect(execute.mock.calls.every(([sql])=>sql.startsWith('SELECT'))).toBe(true);
  });
});
