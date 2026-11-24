import { ClientFiscalUseCases } from './application/use-cases/client-fiscal.js';
import { UnconfiguredClientFiscalVerificationProvider } from './infrastructure/services/unconfigured-client-fiscal-verification-provider.js';
import { LegacyMysqlClientFiscalDataSource } from './infrastructure/datasources/legacy-mysql-client-fiscal-data-source.js';
import { ClientFiscalRepositoryImpl } from './infrastructure/repositories/client-fiscal-repository-impl.js';
import { ClientFiscalController, createClientFiscalRouter } from './presentation/http/client-fiscal-controller.js';
import type { Router } from 'express';
import { CaptureCustomerCollection } from './application/use-cases/capture-customer-collection.js';
import { ReverseCustomerCollection } from './application/use-cases/reverse-customer-collection.js';
import { MysqlPostingReversalReferences } from '../../purchasing/purchase-receptions/infrastructure/datasources/mysql-posting-reversal-references.js';
import { GetClientBalance } from './application/use-cases/get-client-balance.js';
import { GetClientActions } from './application/use-cases/get-client-actions.js';
import { GetClientAnalytics } from './application/use-cases/get-client-analytics.js';
import { GetClientMovements } from './application/use-cases/get-client-movements.js';
import { GetClientConsultations } from './application/use-cases/get-client-consultations.js';
import { GetClient } from './application/use-cases/get-client.js';
import { GetFirstActiveClient } from './application/use-cases/get-first-active-client.js';
import { SearchClients } from './application/use-cases/search-clients.js';
import { CreateClient } from './application/use-cases/create-client.js';
import { DeleteClient } from './application/use-cases/delete-client.js';
import { NavigateClient } from './application/use-cases/navigate-client.js';
import { UpdateClient } from './application/use-cases/update-client.js';
import {
  ClientBalanceWithSalesRemissionsDataSource, ClientMovementsWithSalesRemissionsDataSource,
} from './infrastructure/datasources/client-ledger-with-sales-remissions-data-source.js';
import { ClientsWithSalesRemissionsDataSource } from './infrastructure/datasources/clients-with-sales-remissions-data-source.js';
import { LegacyMysqlClientBalanceDataSource } from './infrastructure/datasources/legacy-mysql-client-balance-data-source.js';
import { ClientActionsWithCatalogDataSource } from './infrastructure/datasources/client-actions-with-catalog-data-source.js';
import { LegacyMysqlClientAnalyticsDataSource } from './infrastructure/datasources/legacy-mysql-client-analytics-data-source.js';
import { LegacyMysqlClientMovementsDataSource } from './infrastructure/datasources/legacy-mysql-client-movements-data-source.js';
import { LegacyMysqlClientConsultationsDataSource } from './infrastructure/datasources/legacy-mysql-client-consultations-data-source.js';
import { MysqlCustomerCollectionReferences } from './infrastructure/datasources/mysql-customer-collection-references.js';
import { PostgresCustomerCollections } from './infrastructure/datasources/postgres-customer-collections.js';
import { PostgresCustomerCollectionReversals } from './infrastructure/datasources/postgres-customer-collection-reversals.js';
import { ClientActionsRepositoryImpl } from './infrastructure/repositories/client-actions-repository-impl.js';
import { ClientAnalyticsRepositoryImpl } from './infrastructure/repositories/client-analytics-repository-impl.js';
import { ClientBalanceRepositoryImpl } from './infrastructure/repositories/client-balance-repository-impl.js';
import { ClientConsultationsRepositoryImpl } from './infrastructure/repositories/client-consultations-repository-impl.js';
import { ClientMovementsRepositoryImpl } from './infrastructure/repositories/client-movements-repository-impl.js';
import { ClientsRepositoryImpl } from './infrastructure/repositories/clients-repository-impl.js';
import { ClientsController } from './presentation/http/clients-controller.js';
import { createClientsRouter } from './presentation/http/clients-routes.js';

export const createClientsModule = (): Router => {
  const clientsDataSource = new ClientsWithSalesRemissionsDataSource();
  const repository = new ClientsRepositoryImpl(clientsDataSource);
  const balanceRepository = new ClientBalanceRepositoryImpl(
    new ClientBalanceWithSalesRemissionsDataSource(new LegacyMysqlClientBalanceDataSource()),
  );
  const movementsRepository = new ClientMovementsRepositoryImpl(
    new ClientMovementsWithSalesRemissionsDataSource(new LegacyMysqlClientMovementsDataSource()),
  );
  const consultationsRepository = new ClientConsultationsRepositoryImpl(
    new LegacyMysqlClientConsultationsDataSource(),
  );
  const actionsRepository = new ClientActionsRepositoryImpl(
    new ClientActionsWithCatalogDataSource(),
  );
  const analyticsRepository = new ClientAnalyticsRepositoryImpl(
    new LegacyMysqlClientAnalyticsDataSource(),
  );
  const getClient = new GetClient(repository);
  const getFirstActiveClient = new GetFirstActiveClient(repository);
  const searchClients = new SearchClients(repository);
  const getClientBalance = new GetClientBalance(balanceRepository);
  const getClientMovements = new GetClientMovements(movementsRepository);
  const getClientConsultations = new GetClientConsultations(consultationsRepository);
  const getClientActions = new GetClientActions(actionsRepository);
  const getClientAnalytics = new GetClientAnalytics(analyticsRepository);
  const navigateClient = new NavigateClient(repository, repository);
  const createClient = new CreateClient(repository, () => clientsDataSource.defaultAccountingAccount());
  const updateClient = new UpdateClient(repository);
  const deleteClient = new DeleteClient(repository);
  const controller = new ClientsController(
    getClient,
    getFirstActiveClient,
    searchClients,
    getClientMovements,
    getClientBalance,
    getClientConsultations,
    getClientActions,
    getClientAnalytics,
    navigateClient,
    createClient,
    updateClient,
    deleteClient,
    new CaptureCustomerCollection(new PostgresCustomerCollections(), new MysqlCustomerCollectionReferences()),
    new ReverseCustomerCollection(new PostgresCustomerCollectionReversals(), new MysqlPostingReversalReferences()),
    (id, blocked, reason) => clientsDataSource.block(id, blocked, reason),
  );

  const router = createClientsRouter(controller);
  router.use('/:clientId/actions/fiscal-verification', createClientFiscalRouter(
    new ClientFiscalController(new ClientFiscalUseCases(
      new ClientFiscalRepositoryImpl(new LegacyMysqlClientFiscalDataSource()),
      new UnconfiguredClientFiscalVerificationProvider(),
    )),
  ));
  return router;
};
