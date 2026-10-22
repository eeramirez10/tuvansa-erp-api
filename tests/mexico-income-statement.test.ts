import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GetIncomeStatement } from '../src/modules/accounting/reports/application/use-cases/get-income-statement.js';
import { GetMexicoIncomeStatement } from '../src/modules/accounting/reports/application/use-cases/get-mexico-income-statement.js';
import type { IncomeStatementAccount, IncomeStatementSettings } from '../src/modules/accounting/reports/domain/entities/income-statement.js';
import type { IncomeStatementRepository } from '../src/modules/accounting/reports/domain/repositories/income-statement-repository.js';
import { createIncomeStatementRouter } from '../src/modules/accounting/reports/presentation/http/income-statement-routes.js';
import { errorHandler } from '../src/shared/infrastructure/http/error-handler.js';
const pool=vi.hoisted(()=>({execute:vi.fn()}));
vi.mock('../src/shared/infrastructure/database/legacy-mysql-pool.js',()=>({legacyMysqlPool:pool}));
import { LegacyMysqlIncomeStatementDataSource } from '../src/modules/accounting/reports/infrastructure/datasources/legacy-mysql-income-statement-data-source.js';

const settings:IncomeStatementSettings={companyName:'EMPRESA',companyLegalName:'EMPRESA',fiscalStart:'2025-01-01',fiscalEnd:'2026-12-31',levelLengths:[1,2,4,7],currentYear:2026,mexico:{warehouseCode:'01',name:'SUC. MEXICO',companyId:1,costCenter:-1}};
const balances:IncomeStatementAccount[]=([['4',-100],['4001',-100],['5',40],['5001',40],['6',30],['6002',20],['6003',10],['7',5],['7001',5]] as const).map(([code,value])=>({id:Number(code),code,name:'Cuenta '+code,nature:code.startsWith('4')?1:0,balance:value,debit:Math.max(value,0),credit:Math.max(-value,0)}));
const repo=():IncomeStatementRepository=>({settings:vi.fn().mockResolvedValue(settings),accounts:vi.fn().mockResolvedValue(balances)});
const app=(repository=repo())=>express().use(createIncomeStatementRouter(new GetIncomeStatement(repository),new GetMexicoIncomeStatement(repository))).use(errorHandler);
afterEach(()=>vi.clearAllMocks());

describe('Estado de resultados exclusivo de México',()=>{
 it('usa año CIAPERIODO y mes 8, sin desplazar agosto al periodo 20',async()=>{
  const repository=repo();
  const service=new GetMexicoIncomeStatement(repository,()=>new Date('2026-10-22T12:00:00Z'));
  expect(await service.options()).toMatchObject({year:2026,defaultMonth:10,branch:{warehouseCode:'01',companyId:1,costCenter:-1}});
  expect((await service.options()).months).toHaveLength(12);
  const report=await service.execute({year:2026,month:8});
  expect(repository.accounts).toHaveBeenCalledWith({accounts:'8',month:8,level:3},4,{companyId:1,costCenter:-1});
  expect(report).toMatchObject({asOf:'2026-08-31',accountingYear:2026,financial:{scopeLabel:'MÉXICO'}});
 });
 it('respeta la compañía del catálogo de México y no usa el centro 1 como sustituto',async()=>{
  const repository=repo();vi.mocked(repository.settings).mockResolvedValue({...settings,mexico:{...settings.mexico!,companyId:7}});
  await new GetMexicoIncomeStatement(repository).execute({year:2026,month:8});
  expect(repository.accounts).toHaveBeenCalledWith(expect.anything(),4,{companyId:7,costCenter:-1});
 });
 it('trata provisiones vacías como cero, calcula utilidad neta y porcentajes sobre ingresos de México',async()=>{
  const report=await new GetMexicoIncomeStatement(repo()).execute({year:2026,month:8});
  for(const key of ['isr','ptu','additional-centralized'])expect(report.financial.rows.find(row=>row.key===key)).toMatchObject({month:0,accumulated:0,monthPercent:0,accumulatedPercent:0});
  expect(report.financial.rows.find(row=>row.key==='net-profit')).toMatchObject({month:25,accumulated:25,monthPercent:.25,accumulatedPercent:.25});
  expect(report.financial.reconciliation).toEqual({month:25,accumulated:25,differenceMonth:0,differenceAccumulated:0});
 });
 it('rechaza otros ejercicios y meses antes de leer saldos',async()=>{
  const repository=repo();const service=new GetMexicoIncomeStatement(repository);
  for(const input of [{year:2025,month:8},{year:2026,month:0},{year:2026,month:13},{year:2026,month:8.5}])await expect(service.execute(input)).rejects.toMatchObject({statusCode:400});
  expect(repository.accounts).not.toHaveBeenCalled();
 });
 it('rechaza configuración incompleta o una sucursal distinta',async()=>{
  const repository=repo();const service=new GetMexicoIncomeStatement(repository);
  for(const invalid of [{...settings,currentYear:undefined},{...settings,currentYear:0},{...settings,mexico:undefined},{...settings,mexico:{...settings.mexico!,costCenter:1}}]){
   vi.mocked(repository.settings).mockResolvedValue(invalid);
   await expect(service.options()).rejects.toMatchObject({statusCode:409});
  }
  expect(repository.accounts).not.toHaveBeenCalled();
 });
 it('publica GETs sin caché y no admite cambiar sucursal o compañía mediante HTTP',async()=>{
  const repository=repo(),http=app(repository);
  await request(http).get('/income-statement/mexico/options').expect(200).expect('Cache-Control','no-store');
  for(const query of ['month=8&year=2026&branch=02','month=8&year=2026&companyId=2','month=8&year=2026&costCenter=1','month=20&year=2026','month=8&year=2025','month=8'])await request(http).get('/income-statement/mexico?'+query).expect(400);
  expect(repository.accounts).not.toHaveBeenCalled();
  const response=await request(http).get('/income-statement/mexico?month=8&year=2026').expect(200).expect('Cache-Control','no-store');
  expect(response.body.data.financial.rows.find((row:{key:string})=>row.key==='net-profit').accumulated).toBe(25);
 });
 it('lee CIAPERIODO y CATMULTICIA del almacén 01 con parámetros, conservando catálogo CEN separado',async()=>{
  pool.execute.mockResolvedValueOnce([[{companyName:'EMPRESA',fiscalStart:'2025-01-01',fiscalEnd:'2026-12-31',currentYear:'2026',CIACONNIV1:1,CIACONNIV2:2,CIACONNIV3:4}]])
   .mockResolvedValueOnce([[{name:'EMPRESA'}]]).mockResolvedValueOnce([[{warehouseCode:'01',name:'SUC. MEXICO',companyId:1}]]);
  const result=await new LegacyMysqlIncomeStatementDataSource().settings();
  expect(result).toMatchObject({currentYear:2026,mexico:settings.mexico});
  expect(pool.execute.mock.calls[0]![0]).toContain('CIAPERIODO AS currentYear');
  expect(pool.execute.mock.calls[2]![0]).toContain('CATMULTICIA AS companyId');
  expect(pool.execute.mock.calls[2]![1]).toEqual(['01','']);
 });
 it('parametriza el alcance y selecciona columnas del mes 8, sin incluir otra compañía',async()=>{
  pool.execute.mockResolvedValueOnce([[]]);
  await new LegacyMysqlIncomeStatementDataSource().accounts({accounts:'8',month:8,level:3},4,{companyId:1,costCenter:-1});
  const [sql,params]=pool.execute.mock.calls[0]!;
  expect(sql).toContain('c.BCCS108 AS balance,c.BCCSC108 AS debit,c.BCCSA108 AS credit');
  expect(params).toEqual(['4',8,'Z',4,1,-1]);
 });
});
