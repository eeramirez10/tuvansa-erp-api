import type { IncomeStatementDataSource } from '../../domain/datasources/income-statement-data-source.js';
import type { IncomeStatementCriteria, IncomeStatementScope } from '../../domain/entities/income-statement.js';
import type { IncomeStatementRepository } from '../../domain/repositories/income-statement-repository.js';

import type { BranchIncomeStatementsRepository } from '../../domain/repositories/branch-income-statements-repository.js';

export class IncomeStatementRepositoryImpl implements IncomeStatementRepository, BranchIncomeStatementsRepository {
  constructor(private readonly source: IncomeStatementDataSource) {}
  branches() { return this.source.branches(); }
  accountsByCompanies(criteria: IncomeStatementCriteria, codeLength: number, companyIds: number[]) { return this.source.accountsByCompanies(criteria,codeLength,companyIds); }
  settings() { return this.source.settings(); }
  accounts(criteria: IncomeStatementCriteria, codeLength: number, scope?: IncomeStatementScope) { return this.source.accounts(criteria,codeLength,scope); }
}
