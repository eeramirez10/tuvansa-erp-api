import type { Client } from '../../domain/entities/client.js';
import type { ClientsDataSource } from '../../domain/datasources/clients-data-source.js';
import type {
  ClientCreateValues,
  ClientNavigationDirection,
  ClientToolbarRepository,
  ClientWriteValues,
  DeleteClientResult,
} from '../../domain/repositories/client-toolbar-repository.js';
import type {
  ClientSearchCriteria,
  ClientSearchResult,
  ClientsRepository,
} from '../../domain/repositories/clients-repository.js';

export class ClientsRepositoryImpl implements ClientsRepository, ClientToolbarRepository {
  constructor(private readonly dataSource: ClientsDataSource) {}

  findById(clientId: number): Promise<Client | null> {
    return this.dataSource.findById(clientId);
  }

  search(criteria: ClientSearchCriteria): Promise<ClientSearchResult> {
    return this.dataSource.search(criteria);
  }

  findAdjacent(
    clientId: number,
    direction: ClientNavigationDirection,
  ): Promise<Client | null> {
    return this.dataSource.findAdjacent(clientId, direction);
  }

  codeExists(code: string, excludingClientId?: number): Promise<boolean> {
    return this.dataSource.codeExists(code, excludingClientId);
  }

  accountingAccountExists(account: string): Promise<boolean> {
    return this.dataSource.accountingAccountExists(account);
  }

  create(values: ClientCreateValues): Promise<Client> {
    return this.dataSource.create(values);
  }

  update(clientId: number, values: ClientWriteValues): Promise<Client | null> {
    return this.dataSource.update(clientId, values);
  }

  delete(clientId: number): Promise<DeleteClientResult> {
    return this.dataSource.delete(clientId);
  }
}
