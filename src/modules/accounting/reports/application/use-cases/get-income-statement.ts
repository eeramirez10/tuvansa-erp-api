import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import { buildIncomeStatement } from '../../domain/entities/build-income-statement.js';
import type { IncomeStatementCriteria, IncomeStatementOptions } from '../../domain/entities/income-statement.js';
import type { IncomeStatementRepository } from '../../domain/repositories/income-statement-repository.js';

const invalid = (message: string) => new ApplicationError(message,'INCOME_STATEMENT_INVALID',400);
export class GetIncomeStatement {
  constructor(private readonly repository: IncomeStatementRepository, private readonly now = () => new Date()) {}
  async options(): Promise<IncomeStatementOptions> {
    const settings = await this.repository.settings();
    const first = new Date(settings.fiscalStart+'T00:00:00Z');
    const last = new Date(settings.fiscalEnd+'T00:00:00Z');
    if (!Number.isFinite(first.getTime()) || !Number.isFinite(last.getTime()) || first.getUTCFullYear()<2000 || last<first) {
      throw new ApplicationError('Revisa las fechas del ejercicio contable en PROSCAI.','INCOME_STATEMENT_CONFIGURATION',409);
    }
    const count = Math.min(24,(last.getUTCFullYear()-first.getUTCFullYear())*12+last.getUTCMonth()-first.getUTCMonth()+1);
    const months = Array.from({length:count},(_,i)=>{
      const date = new Date(Date.UTC(first.getUTCFullYear(),first.getUTCMonth()+i+1,0));
      return {value:i+1,label:date.toLocaleDateString('es-MX',{month:'long',year:'numeric',timeZone:'UTC'}),asOf:date.toISOString().slice(0,10)};
    });
    const levels = settings.levelLengths.flatMap((codeLength,i)=>codeLength>0 ? [{value:i+1,codeLength}] : []);
    if (!levels.length) throw new ApplicationError('No hay niveles contables configurados.','INCOME_STATEMENT_CONFIGURATION',409);
    const parts=new Intl.DateTimeFormat('en',{timeZone:'America/Mexico_City',year:'numeric',month:'numeric'}).formatToParts(this.now());
    const year=Number(parts.find(p=>p.type==='year')!.value), month=Number(parts.find(p=>p.type==='month')!.value);
    const defaultMonth=Math.max(1,Math.min(count,(year-first.getUTCFullYear())*12+month-first.getUTCMonth()));
    return {...settings,months,levels,defaultMonth,defaultLevel:levels.find(l=>l.value===3)?.value ?? levels[0]!.value};
  }
  async execute(criteria: IncomeStatementCriteria) {
    const options=await this.options();
    const period=options.months.find(m=>m.value===criteria.month);
    const level=options.levels.find(l=>l.value===criteria.level);
    if (criteria.accounts!=='8' || !period || !level) throw invalid('Selecciona un mes y nivel disponibles para el ejercicio.');
    const accounts=await this.repository.accounts(criteria,level.codeLength);
    return buildIncomeStatement(options,criteria,accounts,period.asOf,this.now().toISOString());
  }
}
