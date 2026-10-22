import type { IncomeStatementDataSource } from '../../domain/datasources/income-statement-data-source.js';
import type { IncomeStatementCriteria } from '../../domain/entities/income-statement.js';
import type { IncomeStatementRepository } from '../../domain/repositories/income-statement-repository.js';

export class IncomeStatementRepositoryImpl implements IncomeStatementRepository {
  constructor(private readonly source: IncomeStatementDataSource) {}
  settings() { return this.source.settings(); }
  accounts(criteria: IncomeStatementCriteria, codeLength: number) { return this.source.accounts(criteria,codeLength); }
}
