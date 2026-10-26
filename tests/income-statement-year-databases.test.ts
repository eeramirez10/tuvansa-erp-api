import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import { LegacyMysqlIncomeStatementDataSource } from '../src/modules/accounting/reports/infrastructure/datasources/legacy-mysql-income-statement-data-source.js';
import { IncomeStatementRepositoryImpl } from '../src/modules/accounting/reports/infrastructure/repositories/income-statement-repository-impl.js';
import { GetBranchIncomeStatements } from '../src/modules/accounting/reports/application/use-cases/get-branch-income-statements.js';

vi.mock('../src/shared/infrastructure/database/legacy-mysql-pool.js',()=>({legacyMysqlPool:{execute:vi.fn()}}));

function database(options: { archives?: string[]; wrongYear?: boolean; inaccessible?: boolean; incomplete?: boolean } = {}) {
  const execute=vi.fn(async (sql: string, params: unknown[] = []) => {
    const archive=sql.includes('`tuvansa2025`.');
    let rows: unknown[]=[];
    if(sql==='SELECT DATABASE() AS databaseName')rows=[{databaseName:'tuvansa'}];
    else if(sql.includes('information_schema.SCHEMATA'))rows=(options.archives??['tuvansa2025']).map(databaseName=>({databaseName}));
    else if(sql.includes('CIANAME AS companyName')) {
      if(archive&&options.inaccessible)throw new Error('Access denied');
      rows=[{companyName:'EMPRESA',currentYear:archive&&!options.wrongYear?2025:2026,fiscalStart:'2025-01-01',fiscalEnd:'2026-12-31',CIACONNIV1:1,CIACONNIV2:2,CIACONNIV3:4}];
    } else if(sql.includes('SELECT CATDESCR AS name'))rows=[{name:'EMPRESA LEGAL'}];
    else if(sql.includes('WHERE CATALM=?'))rows=[{warehouseCode:'01',name:'MEXICO',companyId:archive?11:1}];
    else if(sql.includes('CATALM IN'))rows=Array.from({length:options.incomplete&&archive?6:7},(_,i)=>({warehouseCode:String(i+1).padStart(2,'0'),name:'Sucursal '+(i+1),companyId:i+1+(archive?10:0)}));
    else if(sql.includes('WHERE 1=0'))rows=[];
    else if(sql.includes('AS balance'))rows=(params.slice(5) as number[]).map(companyId=>({companyId,id:companyId,code:'4',name:'INGRESOS',nature:1,balance:archive?-2025:-2026,debit:0,credit:archive?25:26}));
    return [rows as RowDataPacket[],[]];
  });
  const source=new LegacyMysqlIncomeStatementDataSource({execute} as unknown as Pick<Pool,'execute'>);
  return {source,execute};
}

afterEach(()=>vi.restoreAllMocks());

describe('Bases contables por ejercicio',()=>{
  it('publica archivos anuales accesibles con ejercicio coincidente, sin confundir CIAFI con CIAPERIODO',async()=>{
    const {source,execute}=database();
    expect(await source.years()).toEqual([2026,2025]);
    expect(await source.forYear(2026)).toBe(source);
    expect((await (await source.forYear(2025)).settings()).currentYear).toBe(2025);
    const metadata=execute.mock.calls.find(([sql])=>sql.includes('information_schema.SCHEMATA'))!;
    expect(metadata[1]).toEqual(['tuvansa','tuvansa','tuvansa']);
    expect(execute.mock.calls.some(([sql])=>sql.includes('`tuvansa2025`.fccbenc')&&sql.includes('`tuvansa2025`.fbenc')&&sql.includes('c.BCCS112')&&sql.includes('WHERE 1=0'))).toBe(true);
  });

  it('resuelve catálogos y saldos del mismo archivo y mantiene solicitudes de 2026 aisladas en paralelo',async()=>{
    const {source,execute}=database();
    const report=new GetBranchIncomeStatements(new IncomeStatementRepositoryImpl(source),()=>new Date('2026-10-26T16:00:00Z'));
    const [previous,current]=await Promise.all([report.execute({year:2025,month:8,branch:'01'}),report.execute({year:2026,month:8,branch:'01'})]);
    expect(previous).toMatchObject({year:2025,branches:[{branch:{companyId:11},report:{asOf:'2025-08-31',totals:{month:25,accumulated:2025}}}]});
    expect(current).toMatchObject({year:2026,branches:[{branch:{companyId:1},report:{asOf:'2026-08-31',totals:{month:26,accumulated:2026}}}]});
    const history=execute.mock.calls.find(([sql])=>sql.includes('AS balance')&&sql.includes('`tuvansa2025`.fccbenc'))!;
    const active=execute.mock.calls.find(([sql])=>sql.includes('AS balance')&&sql.includes('FROM fccbenc'))!;
    expect(history[1]).toEqual(['4',8,'Z',4,-1,11]);expect(active[1]).toEqual(['4',8,'Z',4,-1,1]);
    expect(execute.mock.calls.every(([sql])=>!/^\s*(USE|SET|INSERT|UPDATE|DELETE)\b/i.test(sql))).toBe(true);
  });

  it.each([{wrongYear:true},{inaccessible:true},{incomplete:true}])('no ofrece ni sustituye un archivo incompatible: %j',async config=>{
    const {source,execute}=database(config);
    expect(await source.years()).toEqual([2026]);
    await expect(source.forYear(2025)).rejects.toMatchObject({statusCode:400,code:'BRANCH_INCOME_STATEMENT_INVALID'});
    expect(await source.forYear(2026)).toBe(source);
    expect(execute.mock.calls.some(([sql])=>sql.includes('AS balance'))).toBe(false);
  });

  it('rechaza años no disponibles y nombres ajenos o manipulados antes de consultar saldos',async()=>{
    const {source,execute}=database({archives:['otro2025','tuvansa2025;DROP TABLE fcia','tuvansa_2025','tuvansa2026']});
    expect(await source.years()).toEqual([2026]);
    for(const year of [2025,1999,2025.5,NaN])await expect(source.forYear(year)).rejects.toMatchObject({statusCode:400});
    expect(execute.mock.calls.some(([sql])=>sql.includes('DROP')||sql.includes('`otro2025`')||sql.includes('AS balance'))).toBe(false);
  });

  it('comparte descubrimiento concurrente y renueva el catálogo al caducar',async()=>{
    const clock=vi.spyOn(Date,'now').mockReturnValue(1000);
    const {source,execute}=database();
    await Promise.all([source.years(),source.years(),source.forYear(2025)]);
    expect(execute.mock.calls.filter(([sql])=>sql.includes('information_schema.SCHEMATA'))).toHaveLength(1);
    clock.mockReturnValue(62000);await source.years();
    expect(execute.mock.calls.filter(([sql])=>sql.includes('information_schema.SCHEMATA'))).toHaveLength(2);
  });
});
