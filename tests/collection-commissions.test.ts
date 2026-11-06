import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GetCollectionCommissions } from '../src/modules/sales/commissions/application/use-cases/get-collection-commissions.js';
import { buildCollectionCommissions, collectionCents, type CollectionInputs, type CollectionOptions } from '../src/modules/sales/commissions/domain/entities/collection-commissions.js';
import { createCollectionCommissionsRouter } from '../src/modules/sales/commissions/presentation/http/collection-commissions-routes.js';
import { CollectionCommissionsRepositoryImpl } from '../src/modules/sales/commissions/infrastructure/repositories/collection-commissions-repository-impl.js';
import { errorHandler } from '../src/shared/infrastructure/http/error-handler.js';
vi.mock('../src/shared/infrastructure/database/legacy-mysql-pool.js', () => ({ legacyMysqlPool: {} }));
import { LegacyMysqlCollectionCommissionsDataSource } from '../src/modules/sales/commissions/infrastructure/datasources/legacy-mysql-collection-commissions-data-source.js';
const options: CollectionOptions = { company: 'TEST', defaultFrom: '', defaultTo: '', branches: [{ code: '01', name: 'MEXICO', warehouses: ['01','15'] }], agents: [{ code: 'A01', name: 'AGENTE' }] };
const criteria = { from: '2026-08-01', to: '2026-08-31', branch: '01', agent: 'all' };
const invoice: CollectionInputs['invoices'][number] = { id: 10, number: 'FE001', date: '2026-07-15', firstPaymentDate: '2026-08-05', lastPaymentDate: '2026-08-25',
  customerCode: '000001', customerName: 'TEST', agentCode: 'A01', agentName: 'AGENTE', warehouse: '15', currency: 1,
  subtotal: '100.00', payments: '-150.00000000', returns: '-10.00000000', freight: '3.50', newCustomer: 'Nuevo', paymentCount: 2, invalidVatCount: 0 };
const input: CollectionInputs = { invoices: [invoice], movements: [], products: [] };
const repo = () => ({ options: vi.fn().mockResolvedValue(options), read: vi.fn().mockResolvedValue(input) });
const connection = () => ({ query: vi.fn().mockResolvedValue([]), execute: vi.fn(), commit: vi.fn(), rollback: vi.fn(), release: vi.fn() });
afterEach(() => vi.clearAllMocks());
describe('Comisiones por cobranza, datos confirmados de métodos 211/213', () => {
  it('incluye una factura anterior al periodo y calcula días a su último pago; aplica el límite documentado', () => {
    const report = buildCollectionCommissions(options, criteria, input, '');
    expect(report.invoices[0]).toMatchObject({ days: 41, branch: '01', subtotalAmount: 100, paymentAmount: -100, returnAmount: -10, totalAmount: 90, freightAmount: 3.5, paymentCapped: true });
    expect(report.totals).toMatchObject({ invoices: 1, payments: 2, subtotal: 100, payment: -100, returns: -10, total: 90 });
  });
  it('no inventa costo, utilidad, LM ni una comisión con una regla faltante', () => {
    const report = buildCollectionCommissions(options, criteria, input, '');
    expect(report).toMatchObject({ status: 'preliminary', calculationReady: false });
    expect(report.invoices[0]).toMatchObject({ cost: null, realCost: null, profit: null, margin: null, lm: null, lmAmount: null, commissionAmount: null });
    expect(report.notes[0]).toContain('214_Calcula_Costo_de__Facturas');
  });
  it('conserva signos, pagos parciales y centavos exactos sin aplicar ABS al total', () => {
    const report = buildCollectionCommissions(options, criteria, { ...input, invoices: [{ ...invoice, payments: '-25.00500000' }, { ...invoice, id: 11, payments: '10.00000000' }] }, '');
    expect(report.totals.payment).toBe(-15.01); expect(report.invoices.map(r => r.paymentCapped)).toEqual([false,false]);
    expect(collectionCents('-0.005')).toBe(-1); expect(collectionCents('0.005')).toBe(1); expect(() => collectionCents('NaN')).toThrow();
  });
  it('señala IVA inválido sin convertir un pago desconocido en cero; vacío explícito', () => {
    const report = buildCollectionCommissions(options, criteria, { ...input, invoices: [{ ...invoice, payments: null, returns: null, invalidVatCount: 2 }] }, '');
    expect(report.invoices[0]?.paymentAmount).toBeNull(); expect(report.totals.payment).toBeNull(); expect(report.totals.total).toBeNull();
    expect(buildCollectionCommissions(options, criteria, { invoices: [], movements: [], products: [] }, '').empty).toBe(true);
  });
  it('resuelve sucursal a almacenes y permite todas, usando fecha local para el periodo inicial', async () => {
    const repository = repo(), useCase = new GetCollectionCommissions(repository, () => new Date('2026-01-01T02:00:00Z'));
    expect(await useCase.options()).toMatchObject({ defaultFrom: '2025-12-01', defaultTo: '2025-12-31' });
    await useCase.execute(criteria); expect(repository.read).toHaveBeenCalledWith(criteria, ['01','15']);
    await useCase.execute({ ...criteria, branch: 'all' }); expect(repository.read).toHaveBeenLastCalledWith({ ...criteria, branch: 'all' }, undefined);
  });
  it('rechaza fechas, periodos excesivos, agentes y sucursales no disponibles antes de consultar', async () => {
    const repository = repo(), useCase = new GetCollectionCommissions(repository);
    for (const next of [{ to: '2026-02-30' }, { from: '2026-09-01' }, { from: '2024-01-01' }, { agent: 'unknown' }, { branch: '99' }]) await expect(useCase.execute({ ...criteria, ...next })).rejects.toMatchObject({ statusCode: 400 });
    expect(repository.read).not.toHaveBeenCalled();
  });
  it('expone GET con filtros estrictos y sin fecha de factura ni selección de base enviada por el cliente', async () => {
    const app = express().use(createCollectionCommissionsRouter(new GetCollectionCommissions(repo()))).use(errorHandler);
    await request(app).get('/collection-commissions/options').expect(200).expect('Cache-Control','no-store');
    const response = await request(app).get('/collection-commissions?from=2026-08-01&to=2026-08-31').expect(200);
    expect(response.body.data.criteria).toEqual(criteria);
    for (const extra of ['database=other','invoiceFrom=2026-08-01','movement=XX','branch=01&branch=02']) await request(app).get('/collection-commissions?from=2026-08-01&to=2026-08-31&'+extra).expect(400);
    await request(app).post('/collection-commissions').expect(404);
  });
  it('separa pagos de partidas, parametriza fechas AFECHA y requiere PA en una lectura consistente', async () => {
    const conn = connection(); conn.execute.mockResolvedValueOnce([[invoice], []]).mockResolvedValueOnce([[], []]).mockResolvedValueOnce([[], []]);
    const source = new LegacyMysqlCollectionCommissionsDataSource({ getConnection: async () => conn } as never);
    await source.read({ ...criteria, agent: 'A01' }, ['01','15']);
    const [sql, params] = conn.execute.mock.calls[0]!;
    expect(params).toEqual(['2026-08-01','2026-09-01','01','15','A01']);
    for (const text of ['a.AFECHA>=?', 'a.AFECHA<?', "a.ATIPMV='PA'", "LEFT(a.ATIPMV,1)='D'", 'ACANT/NULLIF(1+DPORCIVA/100,0)', "HAVING SUM(ATIPMV='PA')>0", 'd.DCANCELADA=0', "LEFT(d.DNUM,2)<>'AF'"]) expect(sql).toContain(text);
    for (const text of ['d.DFECHA>=','faxinv','JOIN fpenc','DSTATUSCFD=3','SUM(ABS(']) expect(sql).not.toContain(text);
    expect(conn.execute.mock.calls[2]?.[0]).toContain('LEFT JOIN finv'); expect(conn.query).toHaveBeenCalledWith('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
    expect(conn.commit).toHaveBeenCalled(); expect(conn.rollback).not.toHaveBeenCalled(); expect(conn.release).toHaveBeenCalled();
  });
  it('no consulta detalles si no hay facturas y revierte/libera ante errores', async () => {
    const conn = connection(); conn.execute.mockResolvedValueOnce([[], []]);
    const source = new LegacyMysqlCollectionCommissionsDataSource({ getConnection: async () => conn } as never);
    expect(await source.read(criteria)).toEqual({ invoices: [], movements: [], products: [] }); expect(conn.execute).toHaveBeenCalledTimes(1);
    conn.execute.mockRejectedValueOnce(new Error('read failure')); await expect(source.read(criteria)).rejects.toThrow('read failure');
    expect(conn.rollback).toHaveBeenCalled(); expect(conn.release).toHaveBeenCalledTimes(2);
  });
  it('el repository delega los filtros sin SQL propio', async () => {
    const source = repo(), repository = new CollectionCommissionsRepositoryImpl(source);
    await repository.options(); await repository.read(criteria, ['01','15']); expect(source.read).toHaveBeenCalledWith(criteria, ['01','15']);
  });
});
