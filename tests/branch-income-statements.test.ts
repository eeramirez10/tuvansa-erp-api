import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GetBranchIncomeStatements } from '../src/modules/accounting/reports/application/use-cases/get-branch-income-statements.js';
import { GetIncomeStatement } from '../src/modules/accounting/reports/application/use-cases/get-income-statement.js';
import { consolidateIncomeStatementAccounts } from '../src/modules/accounting/reports/domain/entities/consolidate-income-statement-accounts.js';
import type { IncomeStatementAccount, IncomeStatementSettings } from '../src/modules/accounting/reports/domain/entities/income-statement.js';
import type { BranchIncomeStatementsRepository } from '../src/modules/accounting/reports/domain/repositories/branch-income-statements-repository.js';
import { createIncomeStatementRouter } from '../src/modules/accounting/reports/presentation/http/income-statement-routes.js';
import { errorHandler } from '../src/shared/infrastructure/http/error-handler.js';
const pool=vi.hoisted(()=>({execute:vi.fn()}));
vi.mock('../src/shared/infrastructure/database/legacy-mysql-pool.js',()=>({legacyMysqlPool:pool}));
import { LegacyMysqlIncomeStatementDataSource } from '../src/modules/accounting/reports/infrastructure/datasources/legacy-mysql-income-statement-data-source.js';
const settings:IncomeStatementSettings={companyName:'EMPRESA',companyLegalName:'EMPRESA',currentYear:2026,fiscalStart:'2025-01-01',fiscalEnd:'2026-12-31',levelLengths:[1,2,4]};
const branches=Array.from({length:7},(_,i)=>({warehouseCode:String(i+1).padStart(2,'0'),companyId:i+1,costCenter:-1,name:'Sucursal '+(i+1)}));
const accounts=(i:number):IncomeStatementAccount[]=>([['4',-100*i],['40',-100*i],['4001',-100*i],['5',40],['5001',40],['6',20],['6002',20],['7',1],['7001',1]] as const).map(([code,value])=>({id:Number(code),code,name:'Cuenta '+code,nature:code.startsWith('4')?1:0,balance:value*10,debit:Math.max(value,0),credit:Math.max(-value,0)}));
const repo=():BranchIncomeStatementsRepository=>({settings:vi.fn().mockResolvedValue(settings),branches:vi.fn().mockResolvedValue(branches),accountsByCompanies:vi.fn().mockImplementation(async (_criteria,_length,ids:number[])=>branches.filter(b=>ids.includes(b.companyId)).map(b=>({companyId:b.companyId,accounts:accounts(b.companyId)})))});
afterEach(()=>vi.clearAllMocks());

describe('Siete sucursales y consolidado',()=>{
 it('consulta las siete compañías una vez y consolida mes y acumulado sin duplicar jerarquías',async()=>{
  const repository=repo(),service=new GetBranchIncomeStatements(repository,()=>new Date('2026-10-22T12:00:00Z'));
  const data=await service.execute({year:2026,month:8});
  expect(repository.accountsByCompanies).toHaveBeenCalledExactlyOnceWith({accounts:'8',month:8,level:3},4,[1,2,3,4,5,6,7]);
  expect(data.branches).toHaveLength(7);expect(data.consolidated!.asOf).toBe('2026-08-31');
  expect(data.consolidated!.totals).toEqual({month:2373,accumulated:23730});
  expect(data.consolidated!.financial!.rows.find(r=>r.key==='total-income')).toMatchObject({month:2800,accumulated:28000});
  expect(data.consolidated!.financial!.rows.find(r=>r.key==='net-profit')).toMatchObject({month:2373,accumulated:23730,monthPercent:2373/2800,accumulatedPercent:2373/2800});
  const summedRatios=data.branches.reduce((sum,item)=>sum+item.report.financial!.rows.find(r=>r.key==='net-profit')!.monthPercent!,0);
  expect(data.consolidated!.financial!.rows.find(r=>r.key==='net-profit')!.monthPercent).not.toBe(summedRatios);
  expect(data.consolidated!.financial!.reconciliation).toMatchObject({differenceMonth:0,differenceAccumulated:0});
  expect(new Set(data.branches.map(item=>item.report.generatedAt))).toEqual(new Set([data.generatedAt]));
 });
 it('valida catálogo completo y compañías únicas antes de leer saldos',async()=>{
  const repository=repo(),service=new GetBranchIncomeStatements(repository);
  for(const invalid of [branches.slice(1),[...branches.slice(0,6),branches[0]!],branches.map(b=>({...b,companyId:1}))]){
   vi.mocked(repository.branches).mockResolvedValue(invalid);
   await expect(service.options()).rejects.toMatchObject({statusCode:409});
  }
  expect(repository.accountsByCompanies).not.toHaveBeenCalled();
 });
 it('rechaza ejercicio ajeno, periodos fuera de calendario y resultados incompletos',async()=>{
  const repository=repo(),service=new GetBranchIncomeStatements(repository);
  for(const criteria of [{year:2025,month:8},{year:2026,month:13},{year:2026,month:0}])await expect(service.execute(criteria)).rejects.toMatchObject({statusCode:400});
  expect(repository.accountsByCompanies).not.toHaveBeenCalled();
  vi.mocked(repository.accountsByCompanies).mockResolvedValue([]);
  await expect(service.execute({year:2026,month:8})).rejects.toMatchObject({statusCode:409});
 });
 it('conserva siete secciones vacías y marca vacío global sin porcentajes inválidos',async()=>{
  const repository=repo();vi.mocked(repository.accountsByCompanies).mockResolvedValue(branches.map(b=>({companyId:b.companyId,accounts:[]})));
  const data=await new GetBranchIncomeStatements(repository).execute({year:2026,month:8});
  expect(data.empty).toBe(true);expect(data.branches).toHaveLength(7);expect(data.consolidated!.totals).toEqual({month:0,accumulated:0});
  expect(data.consolidated!.financial!.rows.every(row=>row.monthPercent===null&&row.accumulatedPercent===null)).toBe(true);
 });
 it('suma centavos, conserva pérdidas y rechaza duplicados o naturalezas incompatibles',()=>{
  const value=(balance:number,nature=1):IncomeStatementAccount=>({id:1,code:'4',name:'Ingresos',nature,balance,debit:0,credit:0});
  expect(consolidateIncomeStatementAccounts([[value(-.1)],[value(-.2)]])[0]!.balance).toBe(-.3);
  expect(consolidateIncomeStatementAccounts([[value(10)],[value(20)]])[0]!.balance).toBe(30);
  expect(()=>consolidateIncomeStatementAccounts([[value(-1),value(-2)]])).toThrow('Duplicate');
  expect(()=>consolidateIncomeStatementAccounts([[value(-1)],[value(-2,0)]])).toThrow('Inconsistent');
 });
 it('GETs sin caché no permiten alterar compañías desde el cliente',async()=>{
  const repository=repo();
  const old=new GetIncomeStatement({settings:()=>Promise.resolve(settings),accounts:()=>Promise.resolve([])});
  const http=express().use(createIncomeStatementRouter(old,undefined,new GetBranchIncomeStatements(repository))).use(errorHandler);
  await request(http).get('/income-statement/branches/options').expect(200).expect('Cache-Control','no-store');
  await request(http).get('/income-statement/branches?year=2026&month=8&companyId=1').expect(400);
  expect(repository.accountsByCompanies).not.toHaveBeenCalled();
  const result=await request(http).get('/income-statement/branches?year=2026&month=8').expect(200).expect('Cache-Control','no-store');
  expect(result.body.data.branches).toHaveLength(7);
 });
 it('catálogo excluye almacenes de tránsito y SQL por lote usa IN parametrizado con periodo permitido',async()=>{
  pool.execute.mockResolvedValueOnce([[{warehouseCode:'01',name:'MEXICO',companyId:1}]]);
  const source=new LegacyMysqlIncomeStatementDataSource();
  expect(await source.branches()).toEqual([{warehouseCode:'01',name:'MEXICO',companyId:1,costCenter:-1}]);
  expect(pool.execute.mock.calls[0]![1]).toEqual(['','01','02','03','04','05','06','07']);
  pool.execute.mockReset();pool.execute.mockResolvedValueOnce([[{companyId:2,id:1,code:'4',name:'Ingreso',nature:1,balance:-10,debit:0,credit:1}]]);
  const result=await source.accountsByCompanies({accounts:'8',month:8,level:3},4,[1,2,3,4,5,6,7]);
  expect(result).toHaveLength(7);expect(result[1]!.accounts[0]).toMatchObject({code:'4',balance:-10});expect(result[0]!.accounts).toEqual([]);
  expect(pool.execute.mock.calls[0]![0]).toContain('c.BCCS108 AS balance');expect(pool.execute.mock.calls[0]![0]).toContain('c.BCCCIA IN (?,?,?,?,?,?,?)');
  expect(pool.execute.mock.calls[0]![1]).toEqual(['4',8,'Z',4,-1,1,2,3,4,5,6,7]);
  pool.execute.mockClear();await expect(source.accountsByCompanies({accounts:'8',month:8,level:3},4,[1,1,1,1,1,1,1])).rejects.toMatchObject({statusCode:400});expect(pool.execute).not.toHaveBeenCalled();
 });
});


describe('Filtros de sucursal y ejercicio',()=>{
 it('publica sólo el ejercicio verificado sin deducir años de CIAFI/CIAFF',async()=>{
  const options=await new GetBranchIncomeStatements(repo()).options();
  expect(options).toMatchObject({year:2026,years:[2026],defaultYear:2026,defaultBranch:'all'});
  expect(options.months).toHaveLength(12);
 });
 it.each(['01','02','03','04','05','06','07'] as const)('lee exclusivamente la sucursal %s sin consolidado duplicado',async branch=>{
  const repository=repo();
  const data=await new GetBranchIncomeStatements(repository).execute({year:2026,month:8,branch});
  expect(data.branch).toBe(branch);expect(data.branches).toHaveLength(1);expect(data.consolidated).toBeNull();
  expect(data.branches[0]!.branch.warehouseCode).toBe(branch);
  expect(repository.accountsByCompanies).toHaveBeenCalledExactlyOnceWith({accounts:'8',month:8,level:3},4,[Number(branch)]);
 });
 it('HTTP rechaza códigos desconocidos y no acepta companyId ni años sin correspondencia',async()=>{
  const repository=repo();
  const old=new GetIncomeStatement({settings:()=>Promise.resolve(settings),accounts:()=>Promise.resolve([])});
  const http=express().use(createIncomeStatementRouter(old,undefined,new GetBranchIncomeStatements(repository))).use(errorHandler);
  for(const query of ['branch=00','branch=1','branch=08','branch=01&companyId=7','branch=01&branch=02'])await request(http).get('/income-statement/branches?year=2026&month=8&'+query).expect(400);
  await request(http).get('/income-statement/branches?year=2025&month=8&branch=01').expect(400);
  expect(repository.accountsByCompanies).not.toHaveBeenCalled();
  const response=await request(http).get('/income-statement/branches?year=2026&month=8&branch=03').expect(200);
  expect(response.body.data).toMatchObject({branch:'03',consolidated:null});expect(response.body.data.branches).toHaveLength(1);
 });
 it('SQL individual conserva filtros parametrizados y rechaza grupos parciales',async()=>{
  pool.execute.mockReset();pool.execute.mockResolvedValueOnce([[{companyId:3,id:1,code:'4',name:'Ingreso',nature:1,balance:-10,debit:0,credit:1}]]);
  const source=new LegacyMysqlIncomeStatementDataSource();
  const data=await source.accountsByCompanies({accounts:'8',month:8,level:3},4,[3]);
  expect(data).toHaveLength(1);expect(data[0]!.companyId).toBe(3);
  expect(pool.execute.mock.calls[0]![0]).toContain('c.BCCCIA IN (?)');
  expect(pool.execute.mock.calls[0]![1]).toEqual(['4',8,'Z',4,-1,3]);
  pool.execute.mockClear();
  for(const ids of [[],[1,2],[1,1],[0]])await expect(source.accountsByCompanies({accounts:'8',month:8,level:3},4,ids)).rejects.toMatchObject({statusCode:400});
  expect(pool.execute).not.toHaveBeenCalled();
 });
});
