import type { CollectionCriteria, CollectionInputs, CollectionOptions } from '../entities/collection-commissions.js';
export interface CollectionCommissionsDataSource {
  options(): Promise<CollectionOptions>;
  read(criteria: CollectionCriteria, warehouses?: string[]): Promise<CollectionInputs>;
}
