import type { MovementDocument, MovementHeader } from '../entities/inventory-movement.js';

export interface MovementFilters {
  document?: string | undefined;
  date?: string | undefined;
  reference?: string | undefined;
  reference2?: string | undefined;
  warehouse?: string | undefined;
  supplier?: string | undefined;
  customer?: string | undefined;
}

export interface MovementSearchCriteria extends MovementFilters {
  limit: number;
  offset: number;
}

export interface MovementSearchResult {
  items: MovementHeader[];
  total: number;
}

export interface MovementsRepository {
  search(criteria: MovementSearchCriteria): Promise<MovementSearchResult>;
  findById(id: number): Promise<MovementDocument | null>;
}
