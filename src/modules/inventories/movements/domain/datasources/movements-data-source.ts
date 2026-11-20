import type { MovementDocument } from '../entities/inventory-movement.js';
import type { MovementSearchCriteria, MovementSearchResult } from '../repositories/movements-repository.js';

export interface MovementsDataSource {
  search(criteria: MovementSearchCriteria): Promise<MovementSearchResult>;
  findById(id: number): Promise<MovementDocument | null>;
}

export interface MovementCancellationDataSource {
  canCancel(document: MovementDocument): Promise<string | null>;
  cancel(id: number): Promise<void>;
}
