import type { IncomeStatementRepository } from '../repositories/income-statement-repository.js';

import type { BranchIncomeStatementsRepository } from '../repositories/branch-income-statements-repository.js';

export interface IncomeStatementDataSource extends IncomeStatementRepository, BranchIncomeStatementsRepository {
  forYear(year: number): Promise<IncomeStatementDataSource>;
}
