import type { Router } from 'express';
import { GetPurchaseReceptionByNumber } from './application/use-cases/get-purchase-reception-by-number.js';
import { GetPurchaseReceptionPanel } from './application/use-cases/get-purchase-reception-panel.js';
import { GetPurchaseReception } from './application/use-cases/get-purchase-reception.js';
import { NavigatePurchaseReception } from './application/use-cases/navigate-purchase-reception.js';
import { SearchPurchaseReceptions } from './application/use-cases/search-purchase-receptions.js';
import { LegacyMysqlPurchaseReceptionsDataSource } from './infrastructure/datasources/legacy-mysql-purchase-receptions-data-source.js';
import { PurchaseReceptionsRepositoryImpl } from './infrastructure/repositories/purchase-receptions-repository-impl.js';
import { PurchaseReceptionsController } from './presentation/http/purchase-receptions-controller.js';
import { createPurchaseReceptionsRouter } from './presentation/http/purchase-receptions-routes.js';

export const createPurchaseReceptionsModule = (): Router => {
  const repository = new PurchaseReceptionsRepositoryImpl(new LegacyMysqlPurchaseReceptionsDataSource());
  const controller = new PurchaseReceptionsController(
    new GetPurchaseReception(repository),
    new GetPurchaseReceptionByNumber(repository),
    new SearchPurchaseReceptions(repository),
    new NavigatePurchaseReception(repository),
    new GetPurchaseReceptionPanel(repository),
  );
  return createPurchaseReceptionsRouter(controller);
};
