import type { IncomeStatementAccount, IncomeStatementCriteria, IncomeStatementSettings, IncomeStatementScope } from '../entities/income-statement.js';

export interface IncomeStatementRepository {
  settings(): Promise<IncomeStatementSettings>;
  accounts(criteria: IncomeStatementCriteria, codeLength: number, scope?: IncomeStatementScope): Promise<IncomeStatementAccount[]>;
}
