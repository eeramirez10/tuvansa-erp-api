import type { Pool, RowDataPacket } from 'mysql2/promise';
import { escapeId } from 'mysql2';
import { legacyMysqlPool } from '../../../../../shared/infrastructure/database/legacy-mysql-pool.js';
import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import { NotFoundError } from '../../../../../shared/domain/errors/not-found-error.js';
import type { IncomeStatementDataSource } from '../../domain/datasources/income-statement-data-source.js';
import type { IncomeStatementAccount, IncomeStatementCriteria, IncomeStatementSettings, IncomeStatementScope, IncomeStatementBranch, CompanyIncomeStatementAccounts } from '../../domain/entities/income-statement.js';

// Fixed whitelist from internal constants, never SQL identifiers supplied by HTTP.
const periods = Array.from({length:24},(_,index)=>{
  const suffix=String(index+1).padStart(2,'0');
  return {balance:'BCCS1'+suffix,debit:'BCCSC1'+suffix,credit:'BCCSA1'+suffix};
});
export class LegacyMysqlIncomeStatementDataSource implements IncomeStatementDataSource {
  private catalogCache?: { expires: number; sources: Map<number, LegacyMysqlIncomeStatementDataSource> };
  private catalogPending: Promise<Map<number, LegacyMysqlIncomeStatementDataSource>> | undefined;
  constructor(private readonly db: Pick<Pool,'execute'> = legacyMysqlPool, private readonly database?: string) {}

  // SQL identifiers come from server metadata, never HTTP or an interpolated requested year.
  private table(name: 'fcia'|'falmcat'|'fccbenc'|'fbenc'): string {
    return this.database===undefined?name:escapeId(this.database)+'.'+name;
  }
  private async discoverYears(): Promise<Map<number, LegacyMysqlIncomeStatementDataSource>> {
    const settings=await this.settings();
    const year=settings.currentYear;
    if(typeof year!=='number'||!Number.isInteger(year)||year<2000||year>2100)throw new ApplicationError('Ejercicio contable no configurado.','BRANCH_INCOME_STATEMENT_CONFIGURATION',409);
    const sources=new Map<number, LegacyMysqlIncomeStatementDataSource>([[year,this]]);
    if(this.database!==undefined)return sources;
    const [current]=await this.db.execute<RowDataPacket[]>('SELECT DATABASE() AS databaseName');
    const base=String(current[0]?.databaseName??'');
    if(!base)throw new ApplicationError('Origen contable no configurado.','BRANCH_INCOME_STATEMENT_CONFIGURATION',409);
    // DERIVADA: archive naming convention requested by the user: <current database><YYYY>.
    const [databases]=await this.db.execute<RowDataPacket[]>(
      'SELECT SCHEMA_NAME AS databaseName FROM information_schema.SCHEMATA '+
      'WHERE LEFT(SCHEMA_NAME,CHAR_LENGTH(?))=? AND CHAR_LENGTH(SCHEMA_NAME)=CHAR_LENGTH(?)+4 ORDER BY SCHEMA_NAME',[base,base,base]);
    await Promise.all(databases.map(async row=>{
      const name=String(row.databaseName);
      if(!name.toLowerCase().startsWith(base.toLowerCase()))return;
      const suffix=name.slice(base.length);
      if(!/^[0-9]{4}$/.test(suffix))return;
      const candidateYear=Number(suffix);
      if(candidateYear<2000||candidateYear>2100)return;
      if(candidateYear===year)return; // Current exercise always uses the primary connection.
      const source=new LegacyMysqlIncomeStatementDataSource(this.db,name);
      try {
        const [archivedSettings,branches]=await Promise.all([source.settings(),source.branches()]);
        if(archivedSettings.currentYear!==candidateYear||branches.length!==7||
          [...branches.map(b=>b.warehouseCode)].sort().join(',')!=='01,02,03,04,05,06,07'||
          new Set(branches.map(b=>b.companyId)).size!==7||branches.some(b=>!Number.isInteger(b.companyId)||b.companyId<1))return;
        const fields=periods.slice(0,12).flatMap(period=>[period.balance,period.debit,period.credit]).map(field=>'c.'+field).join(',');
        await this.db.execute('SELECT c.BCCSEQ,c.BCCCIA,c.BCCCENCOS,b.BCOD,b.BNOMBRE,b.BNATUR,'+fields+
          ' FROM '+source.table('fccbenc')+' c LEFT JOIN '+source.table('fbenc')+' b ON c.BSEQ=b.BSEQ WHERE 1=0');
        sources.set(candidateYear,source);
      } catch {
        // Inaccessible/incompatible archives are not offered. Never fall back to current balances.
      }
    }));
    return sources;
  }
  private async yearCatalog(): Promise<Map<number, LegacyMysqlIncomeStatementDataSource>> {
    if(this.catalogCache&&this.catalogCache.expires>Date.now())return this.catalogCache.sources;
    if(this.catalogPending)return this.catalogPending;
    this.catalogPending=this.discoverYears();
    try {
      const sources=await this.catalogPending;
      this.catalogCache={expires:Date.now()+60_000,sources};
      return sources;
    } finally {this.catalogPending=undefined;}
  }
  async years(): Promise<number[]> { return [...(await this.yearCatalog()).keys()].sort((a,b)=>b-a); }
  async forYear(year: number): Promise<IncomeStatementDataSource> {
    if(!Number.isInteger(year)||year<2000||year>2100)throw new ApplicationError('Ejercicio no disponible.','BRANCH_INCOME_STATEMENT_INVALID',400);
    const source=(await this.yearCatalog()).get(year);
    if(!source)throw new ApplicationError('El ejercicio solicitado no tiene una base contable disponible.','BRANCH_INCOME_STATEMENT_INVALID',400);
    return source;
  }
  async settings(): Promise<IncomeStatementSettings> {
    // DERIVADAS: shared accounting calendar/levels; company label follows captured CIA1 lookup.
    const [rows]=await this.db.execute<RowDataPacket[]>(
      'SELECT CIANAME AS companyName,CIAFI AS fiscalStart,CIAFF AS fiscalEnd,CIAPERIODO AS currentYear,'+
      'CIACONNIV1,CIACONNIV2,CIACONNIV3,CIACONNIV4,CIACONNIV5,CIACONNIV6,CIACONNIV7,CIACONNIV8 '+
      'FROM '+this.table('fcia')+' WHERE CIAKEY=? ORDER BY CIASEQ LIMIT 1',[0]);
    const row=rows[0];
    if (!row) throw new NotFoundError('Configuración contable');
    const [companies]=await this.db.execute<RowDataPacket[]>('SELECT CATDESCR AS name FROM '+this.table('falmcat')+' WHERE CATKEY=? LIMIT 1',['CIA1'.padEnd(18,' ')]);
    // DERIVADA: warehouse 01 is Mexico; CATMULTICIA identifies its accounting company.
    const [branches]=await this.db.execute<RowDataPacket[]>(
      'SELECT CATALM AS warehouseCode,CATDESCR AS name,CATMULTICIA AS companyId FROM '+this.table('falmcat')+' WHERE CATALM=? AND CATKEY=? ORDER BY CATSEQ LIMIT 1',['01','']);
    const branch=branches[0];
    return {currentYear:Number(row.currentYear),
      ...(branch ? {mexico:{warehouseCode:'01' as const,name:String(branch.name).trim(),companyId:Number(branch.companyId),costCenter:-1}} : {}),companyName:String(row.companyName).trim(),companyLegalName:String(companies[0]?.name ?? row.companyName).trim(),
      fiscalStart:String(row.fiscalStart).slice(0,10),fiscalEnd:String(row.fiscalEnd).slice(0,10),
      levelLengths:Array.from({length:8},(_,i)=>Number(row['CIACONNIV'+(i+1)]))};
  }
  async accounts(criteria: IncomeStatementCriteria, codeLength: number, scope: IncomeStatementScope = {companyId:1,costCenter:-1}): Promise<IncomeStatementAccount[]> {
    const fields=Number.isInteger(criteria.month) ? periods[criteria.month-1] : undefined;
    if (!fields || criteria.accounts!=='8' || !Number.isInteger(codeLength) || codeLength<1 || codeLength>30 || !Number.isInteger(scope.companyId) || scope.companyId<1 || !Number.isInteger(scope.costCenter)) {
      throw new ApplicationError('Parámetros contables inválidos.','INCOME_STATEMENT_INVALID',400);
    }
    // ADAPTADA: ACCOUNTING_INCOME_STATEMENT_ACCOUNTS8_MONTH22_LEVEL3_SCREEN.
    // Captured LEFT JOIN, range and order preserved. Default scope is captured company 1 / center -1.
    // Mexico company is derived from CATMULTICIA; no client-supplied company. No LIMIT: full report.
    const sql='SELECT c.BCCSEQ AS id,b.BCOD AS code,b.BNOMBRE AS name,b.BNATUR AS nature,'+
      'c.'+fields.balance+' AS balance,c.'+fields.debit+' AS debit,c.'+fields.credit+' AS credit '+
      'FROM '+this.table('fccbenc')+' c LEFT JOIN '+this.table('fbenc')+' b ON c.BSEQ=b.BSEQ '+
      'WHERE b.BCOD>=? AND b.BCOD<CONCAT(?,?) AND CHAR_LENGTH(b.BCOD)<=? AND c.BCCCIA=? AND c.BCCCENCOS=? '+
      'ORDER BY b.BCOD,c.BCCSEQ';
    const [rows]=await this.db.execute<RowDataPacket[]>(sql,['4',8,'Z',codeLength,scope.companyId,scope.costCenter]);
    return rows.map(row=>({id:Number(row.id),code:String(row.code).trim(),name:String(row.name).trim(),
      nature:Number(row.nature),balance:Number(row.balance),debit:Number(row.debit),credit:Number(row.credit)}));
  }
  async branches(): Promise<IncomeStatementBranch[]> {
    // DERIVADA: the seven operational branches, excluding transit/storage warehouses.
    const [rows]=await this.db.execute<RowDataPacket[]>(
      'SELECT CATALM AS warehouseCode,CATDESCR AS name,CATMULTICIA AS companyId FROM '+this.table('falmcat')+' '+
      'WHERE CATKEY=? AND CATALM IN (?,?,?,?,?,?,?) ORDER BY CATALM,CATSEQ',['','01','02','03','04','05','06','07']);
    return rows.map(row=>({warehouseCode:String(row.warehouseCode).trim(),name:String(row.name).trim(),companyId:Number(row.companyId),costCenter:-1}));
  }
  async accountsByCompanies(criteria: IncomeStatementCriteria, codeLength: number, companyIds: number[]): Promise<CompanyIncomeStatementAccounts[]> {
    const fields=Number.isInteger(criteria.month) ? periods[criteria.month-1] : undefined;
    if (!fields || criteria.accounts!=='8' || !Number.isInteger(codeLength) || codeLength<1 || codeLength>30 || ![1,7].includes(companyIds.length) || new Set(companyIds).size!==companyIds.length || companyIds.some(id=>!Number.isInteger(id)||id<1)) {
      throw new ApplicationError('Alcance contable de sucursales inválido.','BRANCH_INCOME_STATEMENT_INVALID',400);
    }
    // DERIVADA: one branch or seven catalog-mapped companies; same adapted balance projection.
    const sql='SELECT c.BCCCIA AS companyId,c.BCCSEQ AS id,b.BCOD AS code,b.BNOMBRE AS name,b.BNATUR AS nature,'+
      'c.'+fields.balance+' AS balance,c.'+fields.debit+' AS debit,c.'+fields.credit+' AS credit '+
      'FROM '+this.table('fccbenc')+' c LEFT JOIN '+this.table('fbenc')+' b ON c.BSEQ=b.BSEQ '+
      'WHERE b.BCOD>=? AND b.BCOD<CONCAT(?,?) AND CHAR_LENGTH(b.BCOD)<=? AND c.BCCCENCOS=? '+
      'AND c.BCCCIA IN ('+companyIds.map(()=>'?').join(',')+') ORDER BY c.BCCCIA,b.BCOD,c.BCCSEQ';
    const [rows]=await this.db.execute<RowDataPacket[]>(sql,['4',8,'Z',codeLength,-1,...companyIds]);
    return companyIds.map(companyId=>({companyId,accounts:rows.filter(row=>Number(row.companyId)===companyId).map(row=>({
      id:Number(row.id),code:String(row.code).trim(),name:String(row.name).trim(),nature:Number(row.nature),
      balance:Number(row.balance),debit:Number(row.debit),credit:Number(row.credit),
    }))}));
  }

}
