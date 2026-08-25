import { GetClientBalance } from './application/use-cases/get-client-balance.js';
import { GetClientActions } from './application/use-cases/get-client-actions.js';
import { GetClientMovements } from './application/use-cases/get-client-movements.js';
import { GetClientConsultations } from './application/use-cases/get-client-consultations.js';
import { GetClient } from './application/use-cases/get-client.js';
import { SearchClients } from './application/use-cases/search-clients.js';
import { LegacyMysqlClientBalanceRepository } from './infrastructure/repositories/legacy-mysql-client-balance-repository.js';
import { LegacyMysqlClientActionsRepository } from './infrastructure/repositories/legacy-mysql-client-actions-repository.js';
import { LegacyMysqlClientMovementsRepository } from './infrastructure/repositories/legacy-mysql-client-movements-repository.js';
import { LegacyMysqlClientConsultationsRepository } from './infrastructure/repositories/legacy-mysql-client-consultations-repository.js';
import { LegacyMysqlClientsRepository } from './infrastructure/repositories/legacy-mysql-clients-repository.js';
import { ClientsController } from './presentation/http/clients-controller.js';
import { createClientsRouter } from './presentation/http/clients-routes.js';

export const createClientsModule = () => {
  const repository = new LegacyMysqlClientsRepository();
  const balanceRepository = new LegacyMysqlClientBalanceRepository();
  const movementsRepository = new LegacyMysqlClientMovementsRepository();
  const consultationsRepository = new LegacyMysqlClientConsultationsRepository();
  const actionsRepository = new LegacyMysqlClientActionsRepository();
  const getClient = new GetClient(repository);
  const searchClients = new SearchClients(repository);
  const getClientBalance = new GetClientBalance(balanceRepository);
  const getClientMovements = new GetClientMovements(movementsRepository);
  const getClientConsultations = new GetClientConsultations(consultationsRepository);
  const getClientActions = new GetClientActions(actionsRepository);
  const controller = new ClientsController(
    getClient,
    searchClients,
    getClientMovements,
    getClientBalance,
    getClientConsultations,
    getClientActions,
  );

  return createClientsRouter(controller);
};
