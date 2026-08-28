import type { Router } from 'express';
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

export const createOrdersModule = (): Router => {
  const repository = new OrdersRepositoryImpl(new LegacyMysqlOrdersDataSource());
  const panelsRepository = new OrderPanelsRepositoryImpl(new LegacyMysqlOrderPanelsDataSource());
  const controller = new OrdersController(
    new GetOrder(repository), new GetOrderByNumber(repository),
    new SearchOrders(repository), new NavigateOrder(repository),
    new CreateOrder(repository), new UpdateOrder(repository), new DeleteOrder(repository),
    new GetOrderPanel(panelsRepository),
  );
  return createOrdersRouter(controller);
};
