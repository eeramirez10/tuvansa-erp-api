import type { Router } from 'express';
import { GetPurchaseOrderByNumber } from './application/use-cases/get-purchase-order-by-number.js';
import { GetPurchaseOrderPanel } from './application/use-cases/get-purchase-order-panel.js';
import { GetPurchaseOrder } from './application/use-cases/get-purchase-order.js';
import { NavigatePurchaseOrder } from './application/use-cases/navigate-purchase-order.js';
import { SearchPurchaseOrders } from './application/use-cases/search-purchase-orders.js';
import { UpdatePurchaseOrderClassifications } from './application/use-cases/update-purchase-order-classifications.js';
import { EditPurchaseOrder } from './application/use-cases/edit-purchase-order.js';
import { CreatePurchaseOrder } from './application/use-cases/create-purchase-order.js';
import { LegacyMysqlPurchaseOrdersDataSource } from './infrastructure/datasources/legacy-mysql-purchase-orders-data-source.js';
import { LegacyMysqlPurchaseOrderEditDataSource } from './infrastructure/datasources/legacy-mysql-purchase-order-edit-data-source.js';
import { PostgresPurchaseOrderClassifications } from './infrastructure/datasources/postgres-purchase-order-classifications.js';
import { PostgresPurchaseOrderEdits } from './infrastructure/datasources/postgres-purchase-order-edits.js';
import { HybridPurchaseOrdersDataSource } from './infrastructure/datasources/hybrid-purchase-orders-data-source.js';
import { PurchaseOrdersRepositoryImpl } from './infrastructure/repositories/purchase-orders-repository-impl.js';
import { PurchaseOrdersController } from './presentation/http/purchase-orders-controller.js';
import { createPurchaseOrdersRouter } from './presentation/http/purchase-orders-routes.js';

export const createPurchaseOrdersModule = (): Router => {
  const legacy = new LegacyMysqlPurchaseOrdersDataSource();
  const edits = new PostgresPurchaseOrderEdits();
  const capture = new LegacyMysqlPurchaseOrderEditDataSource(legacy);
  const dataSource = new HybridPurchaseOrdersDataSource(legacy, new PostgresPurchaseOrderClassifications(), edits, edits);
  const repository = new PurchaseOrdersRepositoryImpl(dataSource);
  const controller = new PurchaseOrdersController(
    new GetPurchaseOrder(repository),
    new GetPurchaseOrderByNumber(repository),
    new SearchPurchaseOrders(repository),
    new NavigatePurchaseOrder(repository),
    new GetPurchaseOrderPanel(repository),
    new UpdatePurchaseOrderClassifications(repository),
    new EditPurchaseOrder(capture, edits, repository, edits),
    new CreatePurchaseOrder(capture, edits, repository),
  );
  return createPurchaseOrdersRouter(controller);
};
