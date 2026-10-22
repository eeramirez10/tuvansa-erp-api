import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import { buildIncomeStatement } from '../../domain/entities/build-income-statement.js';
import { buildFinancialIncomeStatement } from '../../domain/entities/build-financial-income-statement.js';
import type { IncomeStatementCriteria, MexicoIncomeStatementCriteria, MexicoIncomeStatementOptions } from '../../domain/entities/income-statement.js';
import type { IncomeStatementRepository } from '../../domain/repositories/income-statement-repository.js';

export class GetMexicoIncomeStatement {
  constructor(private readonly repository: IncomeStatementRepository, private readonly now = () => new Date()) {}

  private async configuration() {
    const settings=await this.repository.settings();
    const branch=settings.mexico;
    const year=settings.currentYear;
    if (!branch || branch.warehouseCode!=='01' || !branch.name.trim() || !Number.isInteger(branch.companyId) || branch.companyId<1 || branch.costCenter!==-1 || typeof year!=='number' || !Number.isInteger(year) || year<2000 || year>2100) {
      throw new ApplicationError('Revisa la sucursal México y el ejercicio contable configurado en PROSCAI.','MEXICO_INCOME_STATEMENT_CONFIGURATION',409);
    }
    return {settings,branch,year};
  }

  async options(): Promise<MexicoIncomeStatementOptions> {
    const {settings,branch,year}=await this.configuration();
    const month=Number(new Intl.DateTimeFormat('en',{timeZone:'America/Mexico_City',month:'numeric'}).format(this.now()));
    return {companyName:settings.companyName,year,branch,defaultMonth:month,
      months:Array.from({length:12},(_,i)=>({value:i+1,label:new Date(Date.UTC(year,i,1)).toLocaleDateString('es-MX',{month:'long',timeZone:'UTC'})}))};
  }

  async execute(input: MexicoIncomeStatementCriteria) {
    const {settings,branch,year}=await this.configuration();
    if (!Number.isInteger(input.month) || input.month<1 || input.month>12 || input.year!==year) {
      throw new ApplicationError('Selecciona un mes del ejercicio contable disponible para México.','MEXICO_INCOME_STATEMENT_INVALID',400);
    }
    // DERIVADA: month 1..12 in CIAPERIODO; verified against the Mexico workbook, not the legacy 24-period calendar.
    const criteria: IncomeStatementCriteria={accounts:'8',month:input.month,level:3};
    const accounts=await this.repository.accounts(criteria,4,{companyId:branch.companyId,costCenter:branch.costCenter});
    const asOf=new Date(Date.UTC(year,input.month,0)).toISOString().slice(0,10);
    const report=buildIncomeStatement(settings,criteria,accounts,asOf,this.now().toISOString());
    return {...report,financial:buildFinancialIncomeStatement(accounts,{scopeLabel:'MÉXICO',zeroProvisions:true}),
      branch,accountingYear:year};
  }
}
