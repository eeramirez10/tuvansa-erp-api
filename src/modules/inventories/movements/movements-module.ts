import type { Router } from 'express';
import { env } from '../../../config/env.js';
import { connectPostgres } from '../../../shared/infrastructure/database/postgres-pool.js';
import { CancelInventoryMovement } from './application/use-cases/cancel-inventory-movement.js';
import { ReadInventoryMovements } from './application/use-cases/read-inventory-movements.js';
import type { MovementCancellationRepository } from './domain/repositories/movement-cancellation-repository.js';
import type { MovementsRepository } from './domain/repositories/movements-repository.js';
import { LegacyMysqlMovementsDataSource } from './infrastructure/datasources/legacy-mysql-movements-data-source.js';
import { MovementsWithPurchaseReceptionsDataSource } from './infrastructure/datasources/movements-with-purchase-receptions-data-source.js';
import { PostgresMovementsDataSource } from './infrastructure/datasources/postgres-movements-data-source.js';
import { MovementCancellationRepositoryImpl, MovementsRepositoryImpl } from './infrastructure/repositories/movements-repository-impl.js';
import { createMovementsRouter } from './presentation/http/movements-routes.js';

export const createMovementsModule = (
  repository?: MovementsRepository,
  cancellation?: MovementCancellationRepository,
): Router => {
  if (repository !== undefined) {
    return createMovementsRouter(
      new ReadInventoryMovements(repository, cancellation),
      cancellation === undefined ? undefined : new CancelInventoryMovement(cancellation),
    );
  }

  if (env.INVENTORY_MOVEMENTS_SOURCE === 'postgres') {
    const base = new PostgresMovementsDataSource(connectPostgres);
    const source = new MovementsWithPurchaseReceptionsDataSource(base, base);
    const cancellations = new MovementCancellationRepositoryImpl(source);
    return createMovementsRouter(
      new ReadInventoryMovements(new MovementsRepositoryImpl(source), cancellations),
      new CancelInventoryMovement(cancellations),
    );
  }

  const source = new MovementsWithPurchaseReceptionsDataSource(new LegacyMysqlMovementsDataSource());
  return createMovementsRouter(new ReadInventoryMovements(
    new MovementsRepositoryImpl(source),
    new MovementCancellationRepositoryImpl(source),
  ));
};
