import { Router } from 'express';
import { CaptureOrder } from './application/use-cases/capture-order.js';
import { HybridOrdersDataSource } from './infrastructure/datasources/hybrid-orders-data-source.js';
import { LegacyMysqlOrderReferenceDataSource } from './infrastructure/datasources/legacy-mysql-order-reference-data-source.js';
import { PostgresOrderOverlayDataSource } from './infrastructure/datasources/postgres-order-overlay-data-source.js';
import { OrderCaptureRepositoryImpl } from './infrastructure/repositories/order-capture-repository-impl.js';
import { createOrderCaptureRouter } from './presentation/http/order-capture-router.js';
import { CreateOrder } from './application/use-cases/create-order.js';
import { DeleteOrder } from './application/use-cases/delete-order.js';
import { GetOrder } from './application/use-cases/get-order.js';
import { GetOrderByNumber } from './application/use-cases/get-order-by-number.js';
import { GetOrderPanel } from './application/use-cases/get-order-panel.js';
import { NavigateOrder } from './application/use-cases/navigate-order.js';
import { SearchOrders } from './application/use-cases/search-orders.js';
import { UpdateOrder } from './application/use-cases/update-order.js';
import { LegacyMysqlOrderPanelsDataSource } from './infrastructure/datasources/legacy-mysql-order-panels-data-source.js';
import { LegacyMysqlOrdersDataSource } from './infrastructure/datasources/legacy-mysql-orders-data-source.js';
import { OrderPanelsRepositoryImpl } from './infrastructure/repositories/order-panels-repository-impl.js';
import { OrdersRepositoryImpl } from './infrastructure/repositories/orders-repository-impl.js';
import { OrdersController } from './presentation/http/orders-controller.js';
import { createOrdersRouter } from './presentation/http/orders-routes.js';
import type { OrdersDataSource } from './domain/datasources/orders-data-source.js';
import type { OrderCaptureDataSource } from './domain/datasources/order-capture-data-source.js';
import type { OrderPanelsDataSource } from './domain/datasources/order-panels-data-source.js';

export const createOrdersModule = (source: OrdersDataSource & OrderCaptureDataSource & OrderPanelsDataSource =
  new HybridOrdersDataSource(new LegacyMysqlOrdersDataSource(), new PostgresOrderOverlayDataSource(),
    new LegacyMysqlOrderReferenceDataSource(), new LegacyMysqlOrderPanelsDataSource())): Router => {
  const repository = new OrdersRepositoryImpl(source);
  const panelsRepository = new OrderPanelsRepositoryImpl(source);
  const controller = new OrdersController(
    new GetOrder(repository), new GetOrderByNumber(repository),
    new SearchOrders(repository), new NavigateOrder(repository),
    new CreateOrder(repository), new UpdateOrder(repository), new DeleteOrder(repository),
    new GetOrderPanel(panelsRepository),
  );
  const router = Router();
  router.use(createOrderCaptureRouter(new CaptureOrder(new OrderCaptureRepositoryImpl(source))));
  router.use(createOrdersRouter(controller));
  return router;
};
