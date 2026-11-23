import type { Router } from 'express';
import { GetPurchaseOrderByNumber } from './application/use-cases/get-purchase-order-by-number.js';
import { GetPurchaseOrderPanel } from './application/use-cases/get-purchase-order-panel.js';
import { GetPurchaseOrder } from './application/use-cases/get-purchase-order.js';
import { NavigatePurchaseOrder } from './application/use-cases/navigate-purchase-order.js';
import { SearchPurchaseOrders } from './application/use-cases/search-purchase-orders.js';
import { UpdatePurchaseOrderClassifications } from './application/use-cases/update-purchase-order-classifications.js';
import { EditPurchaseOrder } from './application/use-cases/edit-purchase-order.js';
import { CreatePurchaseOrder } from './application/use-cases/create-purchase-order.js';
import { RemovePurchaseOrder } from './application/use-cases/remove-purchase-order.js';
import { ConfirmPurchaseOrder } from './application/use-cases/confirm-purchase-order.js';
import { ConvertPurchaseOrder } from './application/use-cases/convert-purchase-order.js';
import { EditPurchaseOrderComments } from './application/use-cases/edit-purchase-order-comments.js';
import { DuplicatePurchaseOrder } from './application/use-cases/duplicate-purchase-order.js';
import { ChangePurchaseOrderColorSize } from './application/use-cases/change-purchase-order-color-size.js';
import { SplitPurchaseOrder } from './application/use-cases/split-purchase-order.js';
import { TransferPurchaseOrderBranch } from './application/use-cases/transfer-purchase-order-branch.js';
import { EditPurchaseOrderPieces } from './application/use-cases/edit-purchase-order-pieces.js';
import { ConfirmPurchaseOrderPieces } from './application/use-cases/confirm-purchase-order-pieces.js';
import { AuthorizePurchaseOrder } from './application/use-cases/authorize-purchase-order.js';
import { MysqlPurchaseOrderAuthorizationAccess } from './infrastructure/datasources/mysql-purchase-order-authorization-access.js';
import { MysqlPurchaseOrderPrintReferences } from './infrastructure/datasources/mysql-purchase-order-print-references.js';
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
  const classifications = new PostgresPurchaseOrderClassifications();
  const dataSource = new HybridPurchaseOrdersDataSource(legacy, classifications, edits, edits);
  const repository = new PurchaseOrdersRepositoryImpl(dataSource);
  const comments = new EditPurchaseOrderComments(capture, edits, edits, repository);
  const controller = new PurchaseOrdersController(
    new GetPurchaseOrder(repository),
    new GetPurchaseOrderByNumber(repository),
    new SearchPurchaseOrders(repository),
    new NavigatePurchaseOrder(repository),
    new GetPurchaseOrderPanel(repository),
    new UpdatePurchaseOrderClassifications(repository),
    new EditPurchaseOrder(capture, edits, repository, edits),
    new CreatePurchaseOrder(capture, edits, repository),
    new RemovePurchaseOrder(capture, edits, edits, repository),
    new ConfirmPurchaseOrder(capture, edits, edits, repository),
    new AuthorizePurchaseOrder(capture, edits, edits, classifications, repository, new MysqlPurchaseOrderAuthorizationAccess()),
    new ConvertPurchaseOrder(capture, edits, edits, repository),
    comments,
    new DuplicatePurchaseOrder(capture, edits, repository, comments),
    new ChangePurchaseOrderColorSize(capture, legacy, edits, edits, repository),
    new SplitPurchaseOrder(capture, edits, repository),
    new TransferPurchaseOrderBranch(capture, edits, edits, repository),
    new EditPurchaseOrderPieces(capture, edits, edits, repository),
    new ConfirmPurchaseOrderPieces(capture, edits, edits, repository),
    new MysqlPurchaseOrderPrintReferences(repository),
  );
  return createPurchaseOrdersRouter(controller);
};
