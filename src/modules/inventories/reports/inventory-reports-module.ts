import { GetInventoryByFamily } from './application/use-cases/get-inventory-by-family.js';
import type { InventoryReportsDataSource } from './domain/datasources/inventory-reports-data-source.js';
import { LegacyMysqlInventoryReportsDataSource } from './infrastructure/datasources/legacy-mysql-inventory-reports-data-source.js';
import { InventoryReportsRepositoryImpl } from './infrastructure/repositories/inventory-reports-repository-impl.js';
import { createInventoryReportsRouter } from './presentation/http/inventory-reports-routes.js';
export const createInventoryReportsModule = (source: InventoryReportsDataSource = new LegacyMysqlInventoryReportsDataSource()) =>
  createInventoryReportsRouter(new GetInventoryByFamily(new InventoryReportsRepositoryImpl(source)));
