import type { IncomeStatementAccount, IncomeStatementCriteria, IncomeStatementSettings } from '../entities/income-statement.js';

export interface IncomeStatementRepository {
  settings(): Promise<IncomeStatementSettings>;
  accounts(criteria: IncomeStatementCriteria, codeLength: number): Promise<IncomeStatementAccount[]>;
}
