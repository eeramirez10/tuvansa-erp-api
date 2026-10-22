import type { Pool, RowDataPacket } from 'mysql2/promise';
import { legacyMysqlPool } from '../../../../../shared/infrastructure/database/legacy-mysql-pool.js';
import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import { NotFoundError } from '../../../../../shared/domain/errors/not-found-error.js';
import type { IncomeStatementDataSource } from '../../domain/datasources/income-statement-data-source.js';
import type { IncomeStatementAccount, IncomeStatementCriteria, IncomeStatementSettings } from '../../domain/entities/income-statement.js';

// Fixed whitelist from internal constants, never SQL identifiers supplied by HTTP.
const periods = Array.from({length:24},(_,index)=>{
  const suffix=String(index+1).padStart(2,'0');
  return {balance:'BCCS1'+suffix,debit:'BCCSC1'+suffix,credit:'BCCSA1'+suffix};
});
export class LegacyMysqlIncomeStatementDataSource implements IncomeStatementDataSource {
  constructor(private readonly db: Pick<Pool,'execute'> = legacyMysqlPool) {}
  async settings(): Promise<IncomeStatementSettings> {
    // DERIVADAS: shared accounting calendar/levels; company label follows captured CIA1 lookup.
    const [rows]=await this.db.execute<RowDataPacket[]>(
      'SELECT CIANAME AS companyName,CIAFI AS fiscalStart,CIAFF AS fiscalEnd,'+
      'CIACONNIV1,CIACONNIV2,CIACONNIV3,CIACONNIV4,CIACONNIV5,CIACONNIV6,CIACONNIV7,CIACONNIV8 '+
      'FROM fcia WHERE CIAKEY=? ORDER BY CIASEQ LIMIT 1',[0]);
    const row=rows[0];
    if (!row) throw new NotFoundError('Configuración contable');
    const [companies]=await this.db.execute<RowDataPacket[]>('SELECT CATDESCR AS name FROM falmcat WHERE CATKEY=? LIMIT 1',['CIA1'.padEnd(18,' ')]);
    return {companyName:String(row.companyName).trim(),companyLegalName:String(companies[0]?.name ?? row.companyName).trim(),
      fiscalStart:String(row.fiscalStart).slice(0,10),fiscalEnd:String(row.fiscalEnd).slice(0,10),
      levelLengths:Array.from({length:8},(_,i)=>Number(row['CIACONNIV'+(i+1)]))};
  }
  async accounts(criteria: IncomeStatementCriteria, codeLength: number): Promise<IncomeStatementAccount[]> {
    const fields=Number.isInteger(criteria.month) ? periods[criteria.month-1] : undefined;
    if (!fields || criteria.accounts!=='8' || !Number.isInteger(codeLength) || codeLength<1 || codeLength>30) {
      throw new ApplicationError('Parámetros contables inválidos.','INCOME_STATEMENT_INVALID',400);
    }
    // ADAPTADA: ACCOUNTING_INCOME_STATEMENT_ACCOUNTS8_MONTH22_LEVEL3_SCREEN.
    // Captured LEFT JOIN, range, company, cost center and order preserved. No LIMIT: full report.
    const sql='SELECT c.BCCSEQ AS id,b.BCOD AS code,b.BNOMBRE AS name,b.BNATUR AS nature,'+
      'c.'+fields.balance+' AS balance,c.'+fields.debit+' AS debit,c.'+fields.credit+' AS credit '+
      'FROM fccbenc c LEFT JOIN fbenc b ON c.BSEQ=b.BSEQ '+
      'WHERE b.BCOD>=? AND b.BCOD<CONCAT(?,?) AND CHAR_LENGTH(b.BCOD)<=? AND c.BCCCIA=? AND c.BCCCENCOS=? '+
      'ORDER BY b.BCOD,c.BCCSEQ';
    const [rows]=await this.db.execute<RowDataPacket[]>(sql,['4',8,'Z',codeLength,1,-1]);
    return rows.map(row=>({id:Number(row.id),code:String(row.code).trim(),name:String(row.name).trim(),
      nature:Number(row.nature),balance:Number(row.balance),debit:Number(row.debit),credit:Number(row.credit)}));
  }
}
