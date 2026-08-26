import type { ClientMovementsDataSource } from '../../domain/datasources/client-movements-data-source.js';
import type { ClientMovementsRepository } from '../../domain/repositories/client-movements-repository.js';

export class ClientMovementsRepositoryImpl implements ClientMovementsRepository {
  constructor(private readonly dataSource: ClientMovementsDataSource) {}

  searchByClient: ClientMovementsRepository['searchByClient'] = (criteria) =>
    this.dataSource.searchByClient(criteria);
}
