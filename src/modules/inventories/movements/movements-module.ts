import type { Router } from 'express';
import { ReadInventoryMovements } from './application/use-cases/read-inventory-movements.js';
import type { MovementsRepository } from './domain/repositories/movements-repository.js';
import { LegacyMysqlMovementsDataSource } from './infrastructure/datasources/legacy-mysql-movements-data-source.js';
import { MovementsRepositoryImpl } from './infrastructure/repositories/movements-repository-impl.js';
import { createMovementsRouter } from './presentation/http/movements-routes.js';

export const createMovementsModule = (
  repository: MovementsRepository = new MovementsRepositoryImpl(new LegacyMysqlMovementsDataSource()),
): Router => createMovementsRouter(new ReadInventoryMovements(repository));
