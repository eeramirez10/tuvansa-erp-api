import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import { buildIncomeStatement } from '../../domain/entities/build-income-statement.js';
import { buildFinancialIncomeStatement } from '../../domain/entities/build-financial-income-statement.js';
import { consolidateIncomeStatementAccounts } from '../../domain/entities/consolidate-income-statement-accounts.js';
import type { BranchIncomeStatements, BranchIncomeStatementsOptions, IncomeStatementAccount, IncomeStatementCriteria, MexicoIncomeStatementCriteria } from '../../domain/entities/income-statement.js';
import type { BranchIncomeStatementsRepository } from '../../domain/repositories/branch-income-statements-repository.js';

export class GetBranchIncomeStatements {
  constructor(private readonly repository: BranchIncomeStatementsRepository, private readonly now=()=>new Date()) {}
  private async configuration() {
    const [settings,branches]=await Promise.all([this.repository.settings(),this.repository.branches()]);
    const year=settings.currentYear;
    const codes=['01','02','03','04','05','06','07'];
    if(typeof year!=='number'||!Number.isInteger(year)||year<2000||year>2100||branches.length!==7||new Set(branches.map(b=>b.companyId)).size!==7||codes.some(code=>branches.filter(b=>b.warehouseCode===code).length!==1)||branches.some(b=>!b.name.trim()||!Number.isInteger(b.companyId)||b.companyId<1||b.costCenter!==-1)) {
      throw new ApplicationError('Revisa el ejercicio y la configuración de las siete sucursales.','BRANCH_INCOME_STATEMENT_CONFIGURATION',409);
    }
    return {settings,year,branches:[...branches].sort((a,b)=>a.warehouseCode.localeCompare(b.warehouseCode))};
  }
  async options(): Promise<BranchIncomeStatementsOptions> {
    const {settings,year,branches}=await this.configuration();
    const defaultMonth=Number(new Intl.DateTimeFormat('en',{timeZone:'America/Mexico_City',month:'numeric'}).format(this.now()));
    return {companyName:settings.companyName,year,branches,defaultMonth,
      months:Array.from({length:12},(_,i)=>({value:i+1,label:new Date(Date.UTC(year,i,1)).toLocaleDateString('es-MX',{month:'long',timeZone:'UTC'})}))};
  }
  async execute(input: MexicoIncomeStatementCriteria): Promise<BranchIncomeStatements> {
    const {settings,year,branches}=await this.configuration();
    if(input.year!==year||!Number.isInteger(input.month)||input.month<1||input.month>12)throw new ApplicationError('Selecciona un mes del ejercicio disponible.','BRANCH_INCOME_STATEMENT_INVALID',400);
    const criteria:IncomeStatementCriteria={accounts:'8',month:input.month,level:3};
    const groups=await this.repository.accountsByCompanies(criteria,4,branches.map(branch=>branch.companyId));
    if(groups.length!==7||branches.some(branch=>groups.filter(group=>group.companyId===branch.companyId).length!==1))throw new ApplicationError('La lectura de sucursales está incompleta.','BRANCH_INCOME_STATEMENT_INCOMPLETE',409);
    const generatedAt=this.now().toISOString(),asOf=new Date(Date.UTC(year,input.month,0)).toISOString().slice(0,10);
    const build=(accounts:IncomeStatementAccount[],name:string)=>({...buildIncomeStatement(settings,criteria,accounts,asOf,generatedAt),
      financial:buildFinancialIncomeStatement(accounts,{scopeLabel:name.replace(/^SUC[.]?\s*/i,'').trim(),zeroProvisions:true})});
    const reports=branches.map(branch=>({branch,report:build(groups.find(group=>group.companyId===branch.companyId)!.accounts,branch.name)}));
    const consolidated=build(consolidateIncomeStatementAccounts(groups.map(group=>group.accounts)),'CONSOLIDADO — 7 SUCURSALES');
    return {year,month:input.month,generatedAt,branches:reports,consolidated,empty:reports.every(item=>item.report.empty)};
  }
}
