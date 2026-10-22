import type { IncomeStatementSettings, IncomeStatementBranch, IncomeStatementCriteria, CompanyIncomeStatementAccounts } from '../entities/income-statement.js';
export interface BranchIncomeStatementsRepository {
  settings(): Promise<IncomeStatementSettings>;
  branches(): Promise<IncomeStatementBranch[]>;
  accountsByCompanies(criteria: IncomeStatementCriteria, codeLength: number, companyIds: number[]): Promise<CompanyIncomeStatementAccounts[]>;
}
