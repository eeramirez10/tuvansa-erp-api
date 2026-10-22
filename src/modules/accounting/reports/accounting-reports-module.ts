import { GetBranchIncomeStatements } from './application/use-cases/get-branch-income-statements.js';
import { GetMexicoIncomeStatement } from './application/use-cases/get-mexico-income-statement.js';
import { GetIncomeStatement } from './application/use-cases/get-income-statement.js';
import type { IncomeStatementDataSource } from './domain/datasources/income-statement-data-source.js';
import { LegacyMysqlIncomeStatementDataSource } from './infrastructure/datasources/legacy-mysql-income-statement-data-source.js';
import { IncomeStatementRepositoryImpl } from './infrastructure/repositories/income-statement-repository-impl.js';
import { createIncomeStatementRouter } from './presentation/http/income-statement-routes.js';

export const createAccountingReportsModule = (source: IncomeStatementDataSource = new LegacyMysqlIncomeStatementDataSource()) => {
  const repository=new IncomeStatementRepositoryImpl(source);
  return createIncomeStatementRouter(new GetIncomeStatement(repository),new GetMexicoIncomeStatement(repository),new GetBranchIncomeStatements(repository));
};
