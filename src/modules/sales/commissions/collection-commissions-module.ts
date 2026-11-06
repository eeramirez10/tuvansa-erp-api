import type { Router } from 'express';
import { GetCollectionCommissions } from './application/use-cases/get-collection-commissions.js';
import type { CollectionCommissionsDataSource } from './domain/datasources/collection-commissions-data-source.js';
import { LegacyMysqlCollectionCommissionsDataSource } from './infrastructure/datasources/legacy-mysql-collection-commissions-data-source.js';
import { CollectionCommissionsRepositoryImpl } from './infrastructure/repositories/collection-commissions-repository-impl.js';
import { createCollectionCommissionsRouter } from './presentation/http/collection-commissions-routes.js';
export const createCollectionCommissionsModule = (source: CollectionCommissionsDataSource = new LegacyMysqlCollectionCommissionsDataSource()): Router =>
  createCollectionCommissionsRouter(new GetCollectionCommissions(new CollectionCommissionsRepositoryImpl(source)));
