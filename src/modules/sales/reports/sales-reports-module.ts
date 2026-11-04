import type { Router } from 'express';
import { GetSalesByFamily } from './application/use-cases/get-sales-by-family.js';
import type { SalesReportsDataSource } from './domain/datasources/sales-reports-data-source.js';
import { LegacyMysqlSalesReportsDataSource } from './infrastructure/datasources/legacy-mysql-sales-reports-data-source.js';
import { SalesReportsRepositoryImpl } from './infrastructure/repositories/sales-reports-repository-impl.js';
import { createSalesReportsRouter } from './presentation/http/sales-reports-routes.js';
export const createSalesReportsModule = (source: SalesReportsDataSource = new LegacyMysqlSalesReportsDataSource()): Router =>
  createSalesReportsRouter(new GetSalesByFamily(new SalesReportsRepositoryImpl(source)));
