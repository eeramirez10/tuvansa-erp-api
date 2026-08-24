import { GetClient } from './application/use-cases/get-client.js';
import { SearchClients } from './application/use-cases/search-clients.js';
import { ProscaiClientsRepository } from './infrastructure/repositories/proscai-clients-repository.js';
import { ClientsController } from './presentation/http/clients-controller.js';
import { createClientsRouter } from './presentation/http/clients-routes.js';

export const createClientsModule = () => {
  const repository = new ProscaiClientsRepository();
  const getClient = new GetClient(repository);
  const searchClients = new SearchClients(repository);
  const controller = new ClientsController(getClient, searchClients);

  return createClientsRouter(controller);
};
