import type { Router } from 'express';
import { GetAccountingPolicyByNumber } from './application/use-cases/get-accounting-policy-by-number.js';
import { GetAccountingPolicyClassifications } from './application/use-cases/get-accounting-policy-classifications.js';
import { GetAccountingPolicy } from './application/use-cases/get-accounting-policy.js';
import { NavigateAccountingPolicy } from './application/use-cases/navigate-accounting-policy.js';
import { SearchAccountingPolicies } from './application/use-cases/search-accounting-policies.js';
import { LegacyMysqlAccountingPoliciesDataSource } from './infrastructure/datasources/legacy-mysql-accounting-policies-data-source.js';
import { AccountingPoliciesRepositoryImpl } from './infrastructure/repositories/accounting-policies-repository-impl.js';
import { AccountingPoliciesController } from './presentation/http/accounting-policies-controller.js';
import { createAccountingPoliciesRouter } from './presentation/http/accounting-policies-routes.js';

export const createAccountingPoliciesModule = (): Router => {
  const repository = new AccountingPoliciesRepositoryImpl(new LegacyMysqlAccountingPoliciesDataSource());
  const controller = new AccountingPoliciesController(
    new GetAccountingPolicy(repository),
    new GetAccountingPolicyByNumber(repository),
    new SearchAccountingPolicies(repository),
    new NavigateAccountingPolicy(repository),
    new GetAccountingPolicyClassifications(repository),
  );
  return createAccountingPoliciesRouter(controller);
};
