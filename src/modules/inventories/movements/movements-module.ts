import type { Router } from 'express';
import { env } from '../../../config/env.js';
import { connectPostgres } from '../../../shared/infrastructure/database/postgres-pool.js';
import { CancelInventoryMovement } from './application/use-cases/cancel-inventory-movement.js';
import { CaptureInventoryMovements } from './application/use-cases/capture-inventory-movements.js';
import { ReadInventoryMovementPrint } from './application/use-cases/read-inventory-movement-print.js';
import { ReadInventoryMovements } from './application/use-cases/read-inventory-movements.js';
import type { MovementCancellationRepository } from './domain/repositories/movement-cancellation-repository.js';
import type { MovementsRepository } from './domain/repositories/movements-repository.js';
import { InventoryMovementPrintDataSource } from './infrastructure/datasources/inventory-movement-print-data-source.js';
import { LegacyMysqlMovementsDataSource } from './infrastructure/datasources/legacy-mysql-movements-data-source.js';
import { MovementsWithLocalDocumentsDataSource } from './infrastructure/datasources/movements-with-local-documents-data-source.js';
import { PostgresInventoryAdjustmentsDataSource } from './infrastructure/datasources/postgres-inventory-adjustments.js';
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

  const adjustments = new PostgresInventoryAdjustmentsDataSource();
  const snapshot = env.INVENTORY_MOVEMENTS_SOURCE === 'postgres' ? new PostgresMovementsDataSource(connectPostgres) : undefined;
  const source = new MovementsWithLocalDocumentsDataSource(snapshot ?? new LegacyMysqlMovementsDataSource(), snapshot, adjustments);
  const movements = new MovementsRepositoryImpl(source);
  const cancellations = new MovementCancellationRepositoryImpl(source);
  return createMovementsRouter(
    new ReadInventoryMovements(movements, cancellations),
    new CancelInventoryMovement(cancellations),
    new CaptureInventoryMovements(adjustments),
    new ReadInventoryMovementPrint(movements, new InventoryMovementPrintDataSource()),
  );
};
