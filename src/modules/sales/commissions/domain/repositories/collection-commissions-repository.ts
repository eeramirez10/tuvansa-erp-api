import type { CollectionCriteria, CollectionInputs, CollectionOptions } from '../entities/collection-commissions.js';
export interface CollectionCommissionsRepository {
  options(): Promise<CollectionOptions>;
  read(criteria: CollectionCriteria, warehouses?: string[]): Promise<CollectionInputs>;
}
