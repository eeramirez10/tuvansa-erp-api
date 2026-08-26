import type { ClientBalanceDataSource } from '../../domain/datasources/client-balance-data-source.js';
import type { ClientBalanceRepository } from '../../domain/repositories/client-balance-repository.js';

export class ClientBalanceRepositoryImpl implements ClientBalanceRepository {
  constructor(private readonly dataSource: ClientBalanceDataSource) {}

  searchByClient: ClientBalanceRepository['searchByClient'] = (criteria) =>
    this.dataSource.searchByClient(criteria);
}
