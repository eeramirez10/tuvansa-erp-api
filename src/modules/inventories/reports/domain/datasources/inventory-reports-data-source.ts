import type { InventoryCriteria, InventoryOptions, InventoryProductBalance } from '../entities/inventory-by-family.js';
export interface InventoryReportsDataSource {
  options(): Promise<InventoryOptions>;
  balances(criteria: InventoryCriteria): Promise<InventoryProductBalance[]>;
}
