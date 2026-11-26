import { Router } from 'express';
import { GetAccountingPolicyByNumber } from './application/use-cases/get-accounting-policy-by-number.js';
import { GetAccountingPolicyClassifications } from './application/use-cases/get-accounting-policy-classifications.js';
import { UpdateAccountingPolicyClassification } from './application/use-cases/update-accounting-policy-classification.js';
import { GetAccountingPolicy } from './application/use-cases/get-accounting-policy.js';
import { NavigateAccountingPolicy } from './application/use-cases/navigate-accounting-policy.js';
import { SearchAccountingPolicies } from './application/use-cases/search-accounting-policies.js';
import { ManageManualPolicy } from './application/use-cases/manage-manual-policy.js';
import { DuplicatePolicyLiability } from './application/use-cases/duplicate-policy-liability.js';
import { LegacyMysqlAccountingPoliciesDataSource } from './infrastructure/datasources/legacy-mysql-accounting-policies-data-source.js';
import { AccountingPoliciesWithLocalPostingsDataSource } from './infrastructure/datasources/accounting-policies-with-local-postings-data-source.js';
import { AccountingPoliciesRepositoryImpl } from './infrastructure/repositories/accounting-policies-repository-impl.js';
import { MysqlManualPolicyReferences } from './infrastructure/datasources/mysql-manual-policy-references.js';
import { PostgresManualPolicies } from './infrastructure/datasources/postgres-manual-policies.js';
import { PostgresPolicyClassifications } from './infrastructure/datasources/postgres-policy-classifications.js';
import { AccountingPoliciesController } from './presentation/http/accounting-policies-controller.js';
import { createAccountingPoliciesRouter } from './presentation/http/accounting-policies-routes.js';
import { createManualPolicyRouter } from './presentation/http/manual-policy-routes.js';
import { createPolicyLiabilityRouter } from './presentation/http/policy-liability-routes.js';
import { mysqlPolicyLiabilitySupplier } from './infrastructure/datasources/mysql-policy-liability-supplier.js';
import { BankAccountsWithCatalogDataSource } from '../../treasury/banking/infrastructure/datasources/bank-accounts-with-catalog-data-source.js';
import { webAccess } from '../../general-data/users/users-module.js';
import { requireSessionOrigin, sessionToken } from '../../general-data/users/presentation/web-session-http.js';

export const createAccountingPoliciesModule = (): Router => {
  const legacy = new LegacyMysqlAccountingPoliciesDataSource();
  const chart = new BankAccountsWithCatalogDataSource();
  const classifications = new PostgresPolicyClassifications();
  const repository = new AccountingPoliciesRepositoryImpl(new AccountingPoliciesWithLocalPostingsDataSource(legacy, classifications));
  const controller = new AccountingPoliciesController(
    new GetAccountingPolicy(repository),
    new GetAccountingPolicyByNumber(repository),
    new SearchAccountingPolicies(repository),
    new NavigateAccountingPolicy(repository),
    new GetAccountingPolicyClassifications(repository),
    new UpdateAccountingPolicyClassification(repository, classifications),
  );
  const storage = new PostgresManualPolicies(undefined, undefined, chart);
  const manual = new ManageManualPolicy(new MysqlManualPolicyReferences(chart), storage, repository,
    (id) => legacy.commentLines(id), (id) => legacy.historicalApplication(id));
  const liability = new DuplicatePolicyLiability(repository, mysqlPolicyLiabilitySupplier, manual, storage, id => legacy.findById(id));
  return createAccountingPoliciesRouter(controller, Router()
    .use(createManualPolicyRouter(manual, async (id, request) => {
      if (!await storage.hasLiability(id)) return;
      requireSessionOrigin(request);
      await webAccess.policyLiabilityActor(sessionToken(request));
    }))
    .use(createPolicyLiabilityRouter(liability, token => webAccess.policyLiabilityActor(token))));
};
