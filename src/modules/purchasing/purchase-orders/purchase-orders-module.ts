import type { Router } from 'express';
import { GetPurchaseOrderByNumber } from './application/use-cases/get-purchase-order-by-number.js';
import { GetPurchaseOrderPanel } from './application/use-cases/get-purchase-order-panel.js';
import { GetPurchaseOrder } from './application/use-cases/get-purchase-order.js';
import { NavigatePurchaseOrder } from './application/use-cases/navigate-purchase-order.js';
import { SearchPurchaseOrders } from './application/use-cases/search-purchase-orders.js';
import { LegacyMysqlPurchaseOrdersDataSource } from './infrastructure/datasources/legacy-mysql-purchase-orders-data-source.js';
import { PurchaseOrdersRepositoryImpl } from './infrastructure/repositories/purchase-orders-repository-impl.js';
import { PurchaseOrdersController } from './presentation/http/purchase-orders-controller.js';
import { createPurchaseOrdersRouter } from './presentation/http/purchase-orders-routes.js';

export const createPurchaseOrdersModule = (): Router => {
  const repository = new PurchaseOrdersRepositoryImpl(new LegacyMysqlPurchaseOrdersDataSource());
  const controller = new PurchaseOrdersController(
    new GetPurchaseOrder(repository),
    new GetPurchaseOrderByNumber(repository),
    new SearchPurchaseOrders(repository),
    new NavigatePurchaseOrder(repository),
    new GetPurchaseOrderPanel(repository),
  );
  return createPurchaseOrdersRouter(controller);
};
