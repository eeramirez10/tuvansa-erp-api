import type { MovementCancellationDataSource, MovementsDataSource } from '../../domain/datasources/movements-data-source.js';
import type { MovementSearchCriteria, MovementsRepository } from '../../domain/repositories/movements-repository.js';
import type { MovementCancellationRepository } from '../../domain/repositories/movement-cancellation-repository.js';
import type { MovementDocument } from '../../domain/entities/inventory-movement.js';

export class MovementsRepositoryImpl implements MovementsRepository {
  constructor(private readonly dataSource: MovementsDataSource) {}

  search(criteria: MovementSearchCriteria) {
    return this.dataSource.search(criteria);
  }

  findById(id: number) {
    return this.dataSource.findById(id);
  }
}

export class MovementCancellationRepositoryImpl implements MovementCancellationRepository {
  constructor(private readonly dataSource: MovementCancellationDataSource) {}

  canCancel(document: MovementDocument) {
    return this.dataSource.canCancel(document);
  }

  cancel(id: number) {
    return this.dataSource.cancel(id);
  }
}
