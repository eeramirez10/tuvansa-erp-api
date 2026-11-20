import type { MovementsDataSource } from '../../domain/datasources/movements-data-source.js';
import type { MovementSearchCriteria, MovementsRepository } from '../../domain/repositories/movements-repository.js';

export class MovementsRepositoryImpl implements MovementsRepository {
  constructor(private readonly dataSource: MovementsDataSource) {}

  search(criteria: MovementSearchCriteria) {
    return this.dataSource.search(criteria);
  }

  findById(id: number) {
    return this.dataSource.findById(id);
  }
}
