import type { CollectionCommissionsDataSource } from '../../domain/datasources/collection-commissions-data-source.js';
import type { CollectionCommissionsRepository } from '../../domain/repositories/collection-commissions-repository.js';
import type { CollectionCriteria } from '../../domain/entities/collection-commissions.js';
export class CollectionCommissionsRepositoryImpl implements CollectionCommissionsRepository {
  constructor(private readonly source: CollectionCommissionsDataSource) {}
  options() { return this.source.options(); }
  read(criteria: CollectionCriteria, warehouses?: string[]) { return this.source.read(criteria, warehouses); }
}
