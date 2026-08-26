import { GetClientBalance } from './application/use-cases/get-client-balance.js';
import { GetClientActions } from './application/use-cases/get-client-actions.js';
import { GetClientMovements } from './application/use-cases/get-client-movements.js';
import { GetClientConsultations } from './application/use-cases/get-client-consultations.js';
import { GetClient } from './application/use-cases/get-client.js';
import { SearchClients } from './application/use-cases/search-clients.js';
import { CreateClient } from './application/use-cases/create-client.js';
import { DeleteClient } from './application/use-cases/delete-client.js';
import { NavigateClient } from './application/use-cases/navigate-client.js';
import { UpdateClient } from './application/use-cases/update-client.js';
import { LegacyMysqlClientBalanceDataSource } from './infrastructure/datasources/legacy-mysql-client-balance-data-source.js';
import { LegacyMysqlClientActionsDataSource } from './infrastructure/datasources/legacy-mysql-client-actions-data-source.js';
import { LegacyMysqlClientMovementsDataSource } from './infrastructure/datasources/legacy-mysql-client-movements-data-source.js';
import { LegacyMysqlClientConsultationsDataSource } from './infrastructure/datasources/legacy-mysql-client-consultations-data-source.js';
import { LegacyMysqlClientsDataSource } from './infrastructure/datasources/legacy-mysql-clients-data-source.js';
import { ClientActionsRepositoryImpl } from './infrastructure/repositories/client-actions-repository-impl.js';
import { ClientBalanceRepositoryImpl } from './infrastructure/repositories/client-balance-repository-impl.js';
import { ClientConsultationsRepositoryImpl } from './infrastructure/repositories/client-consultations-repository-impl.js';
import { ClientMovementsRepositoryImpl } from './infrastructure/repositories/client-movements-repository-impl.js';
import { ClientsRepositoryImpl } from './infrastructure/repositories/clients-repository-impl.js';
import { ClientsController } from './presentation/http/clients-controller.js';
import { createClientsRouter } from './presentation/http/clients-routes.js';

export const createClientsModule = () => {
  const clientsDataSource = new LegacyMysqlClientsDataSource();
  const repository = new ClientsRepositoryImpl(clientsDataSource);
  const balanceRepository = new ClientBalanceRepositoryImpl(
    new LegacyMysqlClientBalanceDataSource(),
  );
  const movementsRepository = new ClientMovementsRepositoryImpl(
    new LegacyMysqlClientMovementsDataSource(),
  );
  const consultationsRepository = new ClientConsultationsRepositoryImpl(
    new LegacyMysqlClientConsultationsDataSource(),
  );
  const actionsRepository = new ClientActionsRepositoryImpl(
    new LegacyMysqlClientActionsDataSource(),
  );
  const getClient = new GetClient(repository);
  const searchClients = new SearchClients(repository);
  const getClientBalance = new GetClientBalance(balanceRepository);
  const getClientMovements = new GetClientMovements(movementsRepository);
  const getClientConsultations = new GetClientConsultations(consultationsRepository);
  const getClientActions = new GetClientActions(actionsRepository);
  const navigateClient = new NavigateClient(repository, repository);
  const createClient = new CreateClient(repository);
  const updateClient = new UpdateClient(repository);
  const deleteClient = new DeleteClient(repository);
  const controller = new ClientsController(
    getClient,
    searchClients,
    getClientMovements,
    getClientBalance,
    getClientConsultations,
    getClientActions,
    navigateClient,
    createClient,
    updateClient,
    deleteClient,
  );

  return createClientsRouter(controller);
};
