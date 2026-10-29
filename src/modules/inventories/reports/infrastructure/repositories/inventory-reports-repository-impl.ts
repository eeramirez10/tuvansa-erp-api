import type { InventoryReportsDataSource } from '../../domain/datasources/inventory-reports-data-source.js';
import type { InventoryCriteria } from '../../domain/entities/inventory-by-family.js';
import type { InventoryReportsRepository } from '../../domain/repositories/inventory-reports-repository.js';
export class InventoryReportsRepositoryImpl implements InventoryReportsRepository {
  constructor(private readonly source: InventoryReportsDataSource) {}
  options() { return this.source.options(); }
  balances(criteria: InventoryCriteria) { return this.source.balances(criteria); }
}
