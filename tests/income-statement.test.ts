import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GetIncomeStatement } from '../src/modules/accounting/reports/application/use-cases/get-income-statement.js';
import { buildFinancialIncomeStatement } from '../src/modules/accounting/reports/domain/entities/build-financial-income-statement.js';
import { buildIncomeStatement } from '../src/modules/accounting/reports/domain/entities/build-income-statement.js';
import type { IncomeStatementAccount, IncomeStatementSettings } from '../src/modules/accounting/reports/domain/entities/income-statement.js';
import type { IncomeStatementRepository } from '../src/modules/accounting/reports/domain/repositories/income-statement-repository.js';
import { createIncomeStatementRouter } from '../src/modules/accounting/reports/presentation/http/income-statement-routes.js';
import { errorHandler } from '../src/shared/infrastructure/http/error-handler.js';

const pool=vi.hoisted(()=>({execute:vi.fn()}));
vi.mock('../src/shared/infrastructure/database/legacy-mysql-pool.js',()=>({legacyMysqlPool:pool}));
import { LegacyMysqlIncomeStatementDataSource } from '../src/modules/accounting/reports/infrastructure/datasources/legacy-mysql-income-statement-data-source.js';

const settings:IncomeStatementSettings={companyName:'EMPRESA DE PRUEBA',companyLegalName:'EMPRESA DE PRUEBA',
  fiscalStart:'2025-01-01',fiscalEnd:'2026-12-31',levelLengths:[1,2,4,7,10,13,16,0]};
const criteria={accounts:'8' as const,month:22,level:3};
const account=(code:string,nature:number,balance:number,debit=0,credit=0):IncomeStatementAccount=>({
  id:Number(code),code,name:'Cuenta '+code,nature,balance,debit,credit,
});
const balances=[
  account('4',1,-50,2,12),account('40',1,-50,2,12),
  account('4001',1,-60,0,12),account('4002',0,10,2,0),
  account('6',0,20,2,0),account('60',0,20,2,0),account('6001',0,20,2,0),
];
const repo=():IncomeStatementRepository=>({settings:vi.fn().mockResolvedValue(settings),accounts:vi.fn().mockResolvedValue(balances)});
const app=(source=repo())=>express().use(createIncomeStatementRouter(new GetIncomeStatement(source,()=>new Date('2026-10-22T12:00:00Z')))).use(errorHandler);
afterEach(()=>vi.clearAllMocks());

describe('Estado de resultados',()=>{
  it('respeta naturaleza de cada cuenta, conserva devoluciones positivas y no duplica padres e hijos',()=>{
    const result=buildIncomeStatement(settings,criteria,balances,'2026-10-31','2026-10-22T12:00:00Z');
    expect(result.rows.find(r=>r.code==='4001')).toMatchObject({accumulated:60,month:12});
    expect(result.rows.find(r=>r.code==='4002')).toMatchObject({accumulated:10,month:2});
    expect(result.rows.find(r=>r.kind==='section-total'&&r.code==='4')).toMatchObject({accumulated:50,month:10});
    expect(result.totals).toEqual({month:8,accumulated:30});
    expect(result.rows.at(-1)).toMatchObject({kind:'result',accumulated:30,month:8});
  });
  it('conserva pérdidas y el acumulado aunque el mes no tenga movimiento',()=>{
    const result=buildIncomeStatement(settings,criteria,[account('4',1,-10),account('6',0,30)],'2026-10-31','');
    expect(result.empty).toBe(false);
    expect(result.totals).toEqual({month:0,accumulated:-20});
  });
  it('oculta cuentas sin saldo ni movimiento y admite reportes vacíos',()=>{
    const result=buildIncomeStatement(settings,criteria,[account('4',1,0),account('40',1,0)],'2026-10-31','');
    expect(result.empty).toBe(true);expect(result.rows).toEqual([]);
    expect(result.totals).toEqual({month:0,accumulated:0});
  });
  it('mantiene un grupo con saldo neto cero si contiene cuentas con saldo',()=>{
    const result=buildIncomeStatement(settings,criteria,[account('4',1,0),account('40',1,0),account('4001',1,-10),account('4002',0,10)],'2026-10-31','');
    expect(result.empty).toBe(false);expect(result.totals.accumulated).toBe(0);
    expect(result.rows.filter(r=>r.kind==='account')).toHaveLength(2);
  });
  it('calcula en centavos, sin artefactos de suma de punto flotante',()=>{
    expect(buildIncomeStatement(settings,criteria,[account('4',1,-0.3),account('6',0,0.1)],'','').totals.accumulated).toBe(0.2);
  });
  it('rechaza códigos duplicados para no duplicar importes',()=>{
    expect(()=>buildIncomeStatement(settings,criteria,[account('4',1,-10),account('4',1,-10)],'','')).toThrow('Duplicate accounting code');
  });
  it('resuelve mes 22 y nivel 3 a octubre 2026 y longitud cuatro desde configuración',async()=>{
    const repository=repo();
    const service=new GetIncomeStatement(repository,()=>new Date('2026-10-22T12:00:00Z'));
    const options=await service.options();
    expect(options).toMatchObject({defaultMonth:22,defaultLevel:3});
    expect(options.months[21]).toMatchObject({value:22,asOf:'2026-10-31'});
    expect(options.months[1]?.asOf).toBe('2025-02-28');
    expect((await service.execute(criteria)).asOf).toBe('2026-10-31');
    expect(repository.accounts).toHaveBeenCalledWith(criteria,4);
  });
  it('usa el calendario de México para el periodo predeterminado',async()=>{
    expect((await new GetIncomeStatement(repo(),()=>new Date('2026-01-01T03:00:00Z')).options()).defaultMonth).toBe(12);
  });
  it('rechaza un nivel inexistente y un ejercicio sin configuración, sin leer saldos',async()=>{
    const repository=repo();const service=new GetIncomeStatement(repository);
    await expect(service.execute({...criteria,level:8})).rejects.toMatchObject({statusCode:400});
    expect(repository.accounts).not.toHaveBeenCalled();
    vi.mocked(repository.settings).mockResolvedValue({...settings,fiscalStart:'1900-12-31'});
    await expect(service.options()).rejects.toMatchObject({statusCode:409});
  });
  it('valida parámetros HTTP antes de consultar y deja las lecturas sin caché',async()=>{
    const repository=repo();const http=app(repository);
    for(const query of ['month=0','month=25','month=22&level=99','month=22&accounts=9','month=22&company=2','month=22;DROP TABLE fbenc']){
      await request(http).get('/income-statement?'+query).expect(400);
    }
    expect(repository.accounts).not.toHaveBeenCalled();
    await request(http).get('/income-statement/options').expect(200);
    const response=await request(http).get('/income-statement?month=22&level=3').expect(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body.data.totals).toEqual({month:8,accumulated:30});
  });
  it('usa sólo columnas del periodo permitidas, parámetros para filtros y todas las cuentas sin LIMIT',async()=>{
    pool.execute.mockResolvedValueOnce([[{id:1,code:'4001',name:'Ventas',nature:1,balance:'-12.34',debit:'0',credit:'1.23'}]]);
    const source=new LegacyMysqlIncomeStatementDataSource();
    expect(await source.accounts(criteria,4)).toEqual([account('4001',1,-12.34,0,1.23)].map(a=>({...a,id:1,name:'Ventas'})));
    const [sql,values]=pool.execute.mock.calls[0]!;
    expect(sql).toContain('c.BCCS122 AS balance,c.BCCSC122 AS debit,c.BCCSA122 AS credit');
    expect(sql).toContain('LEFT JOIN fbenc b ON c.BSEQ=b.BSEQ');
    expect(sql).not.toContain('LIMIT');expect(sql).not.toMatch(/SELECT \*/);
    expect(values).toEqual(['4',8,'Z',4,1,-1]);
    pool.execute.mockClear();
    await expect(source.accounts({...criteria,month:Number.NaN},4)).rejects.toMatchObject({statusCode:400});
    expect(pool.execute).not.toHaveBeenCalled();
  });
});


const financialBalances = () => ([
  ['4', -950], ['40', -950], ['4001', -1000], ['4002', 100], ['4003', -50],
  ['5', 400], ['50', 400], ['5001', 400],
  ['6', 500], ['60', 500], ['6001', 100], ['6002', 200], ['6003', 100],
  ['6004', 20], ['6005', 5], ['6006', 50], ['6007', 25],
  ['7', 25], ['70', 25], ['7000', -5], ['7001', 50], ['7002', -10], ['7003', 10], ['7004', -20],
  ['8', 5],
] as const).map(([code, value]) => account(code, code.startsWith('4') && code !== '4002' ? 1 : 0, value, Math.max(value, 0), Math.max(-value, 0)));

describe('Estado de resultados gerencial del Excel', () => {
  it('separa devoluciones, gastos, depreciaciones y financiamiento sin doble conteo y cuadra con ERP', () => {
    const result = buildFinancialIncomeStatement(financialBalances());
    const row = (key: string) => result.rows.find(value => value.key === key)!;
    expect(row('sales').accumulated).toBe(1000);
    expect(row('returns').accumulated).toBe(-100);
    expect(row('other-sales').accumulated).toBe(50);
    expect(row('total-income')).toMatchObject({month:950, accumulated:950, monthPercent:1, accumulatedPercent:1});
    expect(row('gross-profit').accumulated).toBe(550);
    expect(row('total-expenses').accumulated).toBe(475);
    expect(row('operating-profit').accumulated).toBe(75);
    expect(row('financing').accumulated).toBe(35);
    expect(row('other-products').accumulated).toBe(-20);
    expect(row('before-tax')).toMatchObject({month:20, accumulated:20});
    expect(row('before-tax').accumulatedPercent).toBeCloseTo(20 / 950);
    expect(result.reconciliation).toEqual({month:20, accumulated:20, differenceMonth:0, differenceAccumulated:0});
    expect(result.reconciliation.accumulated).toBe(buildIncomeStatement(settings, criteria, financialBalances(), '', '').totals.accumulated);
  });
  it('mantiene ajustes y cuentas nuevas en renglones residuales sin perder el cuadre', () => {
    const balances = financialBalances();
    balances.find(value => value.code === '4')!.balance = -960;
    balances.find(value => value.code === '5')!.balance = 395;
    balances.find(value => value.code === '6')!.balance = 503;
    const result = buildFinancialIncomeStatement(balances);
    expect(result.rows.find(value => value.key === 'unclassified-income')?.accumulated).toBe(10);
    expect(result.rows.find(value => value.key === 'other-costs')?.accumulated).toBe(-5);
    expect(result.rows.find(value => value.key === 'unclassified-expenses')?.accumulated).toBe(3);
    expect(result.rows.find(value => value.key === 'before-tax')?.accumulated).toBe(32);
    expect(result.reconciliation.differenceAccumulated).toBe(0);
  });
  it('no inventa provisiones ni utilidad neta y no produce porcentajes inválidos sin ingresos', () => {
    const result = buildFinancialIncomeStatement([account('6', 0, 10)]);
    for (const row of result.rows) {
      expect(row.monthPercent).toBeNull();
      expect(row.accumulatedPercent).toBeNull();
    }
    for (const key of ['isr', 'ptu', 'additional-centralized', 'net-profit']) {
      expect(result.rows.find(row => row.key === key)).toMatchObject({month:null, accumulated:null});
    }
    expect(result.rows.find(row => row.key === 'before-tax')?.accumulated).toBe(-10);
  });
  it('conserva centavos y rechaza cuentas duplicadas', () => {
    const accounts = [account('4', 1, -0.3), account('5', 0, 0.1)];
    expect(buildFinancialIncomeStatement(accounts).reconciliation.accumulated).toBe(0.2);
    expect(() => buildFinancialIncomeStatement([...accounts, accounts[0]!])).toThrow('Duplicate accounting code');
  });
  it('el formato gerencial conserva el desglose al seleccionar nivel 1 en PROSCAI', async () => {
    const repository = repo();
    vi.mocked(repository.accounts).mockResolvedValue(financialBalances());
    const result = await new GetIncomeStatement(repository).execute({...criteria, level:1});
    expect(repository.accounts).toHaveBeenCalledWith({...criteria, level:1},4);
    expect(result.rows.filter(row => row.code.length > 1)).toEqual([]);
    expect(result.financial.rows.find(row => row.key === 'expense-6002')?.accumulated).toBe(200);
    expect(result.financial.reconciliation.accumulated).toBe(result.totals.accumulated);
  });
});
