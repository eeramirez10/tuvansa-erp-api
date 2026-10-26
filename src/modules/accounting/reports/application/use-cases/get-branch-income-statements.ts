import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import { buildIncomeStatement } from '../../domain/entities/build-income-statement.js';
import { buildFinancialIncomeStatement } from '../../domain/entities/build-financial-income-statement.js';
import { consolidateIncomeStatementAccounts } from '../../domain/entities/consolidate-income-statement-accounts.js';
import type { BranchIncomeStatements, BranchIncomeStatementsOptions, IncomeStatementAccount, IncomeStatementCriteria, BranchIncomeStatementCriteria } from '../../domain/entities/income-statement.js';
import type { BranchIncomeStatementsRepository } from '../../domain/repositories/branch-income-statements-repository.js';

export class GetBranchIncomeStatements {
  constructor(private readonly repository: BranchIncomeStatementsRepository, private readonly now=()=>new Date()) {}
  private async configuration(requestedYear?: number) {
    const repository=requestedYear===undefined?this.repository:await this.repository.forYear(requestedYear);
    const [settings,branches]=await Promise.all([repository.settings(),repository.branches()]);
    const year=settings.currentYear;
    const codes=['01','02','03','04','05','06','07'];
    if(typeof year!=='number'||!Number.isInteger(year)||year<2000||year>2100||branches.length!==7||new Set(branches.map(b=>b.companyId)).size!==7||codes.some(code=>branches.filter(b=>b.warehouseCode===code).length!==1)||branches.some(b=>!b.name.trim()||!Number.isInteger(b.companyId)||b.companyId<1||b.costCenter!==-1)) {
      throw new ApplicationError('Revisa el ejercicio y la configuración de las siete sucursales.','BRANCH_INCOME_STATEMENT_CONFIGURATION',409);
    }
    if(requestedYear!==undefined&&year!==requestedYear)throw new ApplicationError('El ejercicio solicitado no corresponde a su origen contable.','BRANCH_INCOME_STATEMENT_INVALID',400);
    return {repository,settings,year,branches:[...branches].sort((a,b)=>a.warehouseCode.localeCompare(b.warehouseCode))};
  }
  async options(): Promise<BranchIncomeStatementsOptions> {
    const {settings,year,branches}=await this.configuration();
    const defaultMonth=Number(new Intl.DateTimeFormat('en',{timeZone:'America/Mexico_City',month:'numeric'}).format(this.now()));
    const years=await this.repository.years();
    return {companyName:settings.companyName,year,years,defaultYear:year,defaultBranch:'all',branches,defaultMonth,
      months:Array.from({length:12},(_,i)=>({value:i+1,label:new Date(Date.UTC(year,i,1)).toLocaleDateString('es-MX',{month:'long',timeZone:'UTC'})}))};
  }
  async execute(input: BranchIncomeStatementCriteria): Promise<BranchIncomeStatements> {
    const {repository,settings,year,branches}=await this.configuration(input.year);
    if(input.year!==year||!Number.isInteger(input.month)||input.month<1||input.month>12)throw new ApplicationError('Selecciona un mes del ejercicio disponible.','BRANCH_INCOME_STATEMENT_INVALID',400);
    const selection=input.branch??'all';
    const selectedBranches=selection==='all'?branches:branches.filter(branch=>branch.warehouseCode===selection);
    if(selectedBranches.length===0)throw new ApplicationError('Selecciona una sucursal disponible.','BRANCH_INCOME_STATEMENT_INVALID',400);
    const criteria:IncomeStatementCriteria={accounts:'8',month:input.month,level:3};
    const groups=await repository.accountsByCompanies(criteria,4,selectedBranches.map(branch=>branch.companyId));
    if(groups.length!==selectedBranches.length||selectedBranches.some(branch=>groups.filter(group=>group.companyId===branch.companyId).length!==1))throw new ApplicationError('La lectura de sucursales está incompleta.','BRANCH_INCOME_STATEMENT_INCOMPLETE',409);
    const generatedAt=this.now().toISOString(),asOf=new Date(Date.UTC(year,input.month,0)).toISOString().slice(0,10);
    const build=(accounts:IncomeStatementAccount[],name:string)=>({...buildIncomeStatement(settings,criteria,accounts,asOf,generatedAt),
      financial:buildFinancialIncomeStatement(accounts,{scopeLabel:name.replace(/^SUC[.]?\s*/i,'').trim(),zeroProvisions:true})});
    const reports=selectedBranches.map(branch=>({branch,report:build(groups.find(group=>group.companyId===branch.companyId)!.accounts,branch.name)}));
    const consolidated=selection==='all'?build(consolidateIncomeStatementAccounts(groups.map(group=>group.accounts)),'CONSOLIDADO — 7 SUCURSALES'):null;
    return {year,month:input.month,branch:selection,generatedAt,branches:reports,consolidated,empty:reports.every(item=>item.report.empty)};
  }
}
