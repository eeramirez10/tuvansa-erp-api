import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GetSalesByFamily } from '../src/modules/sales/reports/application/use-cases/get-sales-by-family.js';
import { buildSalesByFamily, salesMetersPerUnit, type SalesBalance, type SalesOptions } from '../src/modules/sales/reports/domain/entities/sales-by-family.js';
import type { SalesReportsRepository } from '../src/modules/sales/reports/domain/repositories/sales-reports-repository.js';
import { SalesReportsRepositoryImpl } from '../src/modules/sales/reports/infrastructure/repositories/sales-reports-repository-impl.js';
import { createSalesReportsRouter } from '../src/modules/sales/reports/presentation/http/sales-reports-routes.js';
import { errorHandler } from '../src/shared/infrastructure/http/error-handler.js';
const pool = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('../src/shared/infrastructure/database/legacy-mysql-pool.js', () => ({ legacyMysqlPool: pool }));
import { LegacyMysqlSalesReportsDataSource } from '../src/modules/sales/reports/infrastructure/datasources/legacy-mysql-sales-reports-data-source.js';
const options: SalesOptions = { company: 'TEST', defaultFrom: '', defaultTo: '', defaultBranch: '01', branches: [{ code: '01', name: 'MEXICO', companyId: 1 }, { code: '02', name: 'MTY', companyId: 2 }], families: [{ code: 'B007', name: 'TCC' }, { code: '', name: 'Sin familia' }] };
const criteria = { from: '2026-08-01', to: '2026-08-31', branch: '01', family: 'all' };
const balance = (overrides: Partial<SalesBalance> = {}): SalesBalance => ({ productId: 1, code: '001', description: 'PRODUCTO', family: 'B007', familyName: 'TCC', companyId: 1, unit: 'M', quantity: '8.000', gross: '100.00000000', movements: 3, firstDate: '2026-08-01', lastDate: '2026-08-31', movementTypes: 'FA,FB', missingPrices: 0, ...overrides });
const repository = (): SalesReportsRepository => ({ options: vi.fn().mockResolvedValue(options), balances: vi.fn().mockResolvedValue([balance()]) });
afterEach(() => vi.clearAllMocks());
describe('Ventas por familia', () => {
  it('identifica ventas brutas, agrupando el importe antes de descuentos por familia y sucursal', () => {
    const report = buildSalesByFamily(options, { ...criteria, branch: 'all' }, [balance(), balance({ productId: 2, companyId: 2, gross: '15', quantity: '1' }), balance({ productId: 3, family: '', familyName: 'Sin familia', gross: '5' })], '');
    expect(report.productType).toBe(1); expect(report.basis).toBe('gross'); expect(report.source).toBe('derivada'); expect(report.amount).toBe(120);
    expect(report.groups[0]?.cells.map(c => c.amount)).toEqual([100, 15]);
    expect(report.totals.map(c => c.amount)).toEqual([105, 15]); expect(report.groups[0]?.amount).toBe(115);
    expect(report.groups[0]?.products[0]?.gross).toBe('100.00000000');
  });
  it('usa importes decimales exactos, incluyendo valores negativos en el límite de medio centavo', () => {
    const report = buildSalesByFamily(options, criteria, [balance({ gross: '0.00500000' }), balance({ productId: 2, gross: '-0.00500000' })], '');
    expect(report.amount).toBe(0); expect(report.groups[0]?.products.map(p => p.amount)).toEqual([0.01, -0.01]);
    expect(report.groups[0]?.percentage).toBeNull();
    expect(() => buildSalesByFamily(options, criteria, [balance({ gross: 'NaN' })], '')).toThrow();
  });
  it('convierte sólo las cantidades, conserva la UM y no multiplica el importe por 6.40', () => {
    const report = buildSalesByFamily(options, criteria, [balance({ unit: 'TR', quantity: '2', gross: '100' }), balance({ productId: 2, unit: 'K', quantity: '5', gross: '50' }), balance({ productId: 3, unit: 'FT', quantity: '1', gross: '1' })], '');
    expect(report.amount).toBe(151); expect(report.meters).toBe(13.1048); expect(report.unconvertedProducts).toBe(1);
    expect(report.groups[0]?.products[0]?.meters).toBe(12.8); expect(report.groups[0]?.products[1]?.meters).toBeNull();
    expect(salesMetersPerUnit('M.TR')).toBe(1); expect(salesMetersPerUnit('PZ')).toBe(6.4);
  });
  it('no asigna una compañía desconocida a México y muestra porcentajes por sucursal', () => {
    const report = buildSalesByFamily(options, { ...criteria, branch: 'all' }, [balance(), balance({ companyId: 99, productId: 2, gross: '20' })], '');
    expect(report.columns.map(c => c.code)).toEqual(['01', '02', 'unassigned']); expect(report.groups[0]?.products[1]?.branch).toBe('unassigned');
    expect(report.groups[0]?.cells.map(c => c.percentage)).toEqual([100, null, 100]);
  });
  it('conserva ventas de precio cero y señala importes incompletos sin inventar un precio neto', () => {
    const report = buildSalesByFamily(options, criteria, [balance({ gross: '0', missingPrices: 2 })], '');
    expect(report.empty).toBe(false); expect(report.amount).toBe(0); expect(report.missingPrices).toBe(2); expect(report.meters).toBe(8);
    expect(buildSalesByFamily(options, criteria, [], '').empty).toBe(true);
  });
  it('inicia el periodo en enero usando la fecha de México y traduce la sucursal a compañía', async () => {
    const repo = repository(), useCase = new GetSalesByFamily(repo, () => new Date('2026-01-01T03:00:00Z'));
    expect(await useCase.options()).toMatchObject({ defaultFrom: '2025-01-01', defaultTo: '2025-12-31' });
    await useCase.execute(criteria); expect(repo.balances).toHaveBeenCalledWith(criteria, 1);
    await useCase.execute({ ...criteria, branch: 'all' }); expect(repo.balances).toHaveBeenLastCalledWith({ ...criteria, branch: 'all' }, undefined);
  });
  it('rechaza rangos invertidos, fechas inválidas, sucursales y familias desconocidas antes de leer saldos', async () => {
    const repo = repository(), report = new GetSalesByFamily(repo);
    for (const invalid of [{ ...criteria, from: '2026-09-01' }, { ...criteria, to: '2026-02-30' }, { ...criteria, branch: '15' }, { ...criteria, family: 'XXXX' }, { ...criteria, from: '1900-01-01' }]) await expect(report.execute(invalid)).rejects.toMatchObject({ statusCode: 400 });
    expect(repo.balances).not.toHaveBeenCalled();
  });
  it('expone sólo GET y valida filtros estrictos, sin permitir que el cliente cambie ITIPO', async () => {
    const repo = repository(), app = express().use(createSalesReportsRouter(new GetSalesByFamily(repo))).use(errorHandler);
    await request(app).get('/by-family/options').expect(200).expect('Cache-Control', 'no-store');
    const response = await request(app).get('/by-family?from=2026-08-01&to=2026-08-31').expect(200).expect('Cache-Control', 'no-store');
    expect(response.body.data.criteria).toEqual(criteria);
    for (const query of ['from=2026-08-01&to=2026-08-31&type=2', 'from=2026-08-01&to=2026-08-31&branch=01&branch=02', 'from=2026-08-01&to=2026-08-31&family=XXXX', 'from=2026-08-01&to=2026-08-31&database=other', 'from=2026-09-01&to=2026-08-31']) await request(app).get('/by-family?' + query).expect(400);
    await request(app).post('/by-family').expect(404);
  });
  it('parametriza filtros y deriva ventas brutas con AIPREBR, excluyendo cantidades negativas y cero', async () => {
    pool.execute.mockResolvedValueOnce([[{ ...balance(), companyId: '1', quantity: '8.000', missingPrices: '0' }], []]);
    const rows = await new LegacyMysqlSalesReportsDataSource(pool as never).balances({ ...criteria, family: 'B007' }, 1);
    const [sql, params] = pool.execute.mock.calls[0]!;
    expect(params).toEqual([1, '2026-08-01', '2026-09-01', 1, 'B007']);
    for (const part of ['i.ITIPO=?', 'd.DESFACT=1', 'd.DEST=0', 'a.AIMES=1', "d.DOTROSTXT<>'POS'", 'd.DCONTROLPOS=0', 'a.AICANTF*a.AIPREBR', 'a.AICANTF>0', 'c.CLISEQ<>0', 'GROUP BY FAMTNUM', 'AS CHAR) gross', 'a.AIPREBR IS NULL OR (a.AIPREBR=0 AND a.AIPRECIO<>0)']) expect(sql).toContain(part);
    for (const excluded of ['AICOSTO', "AITIPMV='FA'", 'AIALMACEN=?', 'a.AICANTF*a.AIPRECIO', 'a.AICANTF<>0', 'ABS(']) expect(sql).not.toContain(excluded);
    expect(rows[0]?.gross).toBe('100.00000000');
  });
  it('soporta año bisiesto y todas las sucursales sin fijar compañía 1', async () => {
    pool.execute.mockResolvedValueOnce([[], []]); await new LegacyMysqlSalesReportsDataSource(pool as never).balances({ ...criteria, from: '2024-02-01', to: '2024-02-29', branch: 'all' });
    const [sql, params] = pool.execute.mock.calls[0]!; expect(params).toEqual([1, '2024-02-01', '2024-03-01']); expect(sql).not.toContain('DMULTICIA=?');
  });
  it('ofrece sólo familias del tipo 1 y el repository delega sin consultas propias', async () => {
    pool.execute.mockResolvedValueOnce([[{ code: '01', name: 'MEXICO', companyId: 1 }], []]).mockResolvedValueOnce([[{ code: 'B007', name: 'TCC' }], []]).mockResolvedValueOnce([[{ name: 'TEST' }], []]);
    const result = await new LegacyMysqlSalesReportsDataSource(pool as never).options(); expect(result).toMatchObject({ defaultBranch: '01', families: [{ code: 'B007', name: 'TCC' }] });
    expect(pool.execute.mock.calls[1]?.[1]).toEqual([1]);
    const source = { options: vi.fn().mockResolvedValue(options), balances: vi.fn().mockResolvedValue([]) }, repo = new SalesReportsRepositoryImpl(source);
    await repo.options(); await repo.balances(criteria, 1); expect(source.balances).toHaveBeenCalledWith(criteria, 1);
  });
});
