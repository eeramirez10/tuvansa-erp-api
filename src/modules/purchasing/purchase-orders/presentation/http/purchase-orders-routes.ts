import { Router } from 'express';
import type { PurchaseOrdersController } from './purchase-orders-controller.js';

export const createPurchaseOrdersRouter = (controller: PurchaseOrdersController): Router => {
  const router = Router();
  router.get('/', controller.search);
  router.post('/', controller.create);
  router.get('/create', controller.getCreation);
  router.get('/create/suppliers', controller.searchCreationSuppliers);
  router.get('/create/products', controller.searchCreationProducts);
  router.get('/by-number/:purchaseOrderNumber', controller.getByNumberHandler);
  router.get('/:purchaseOrderId/previous', controller.previous);
  router.get('/:purchaseOrderId/next', controller.next);
  router.get('/:purchaseOrderId/actions/auxiliar', controller.panel('receipts'));
  router.get('/:purchaseOrderId/actions/classifications', controller.panel('classifications'));
  router.patch('/:purchaseOrderId/actions/classifications', controller.classify);
  router.get('/:purchaseOrderId/actions/confirmation', controller.getConfirmation);
  router.patch('/:purchaseOrderId/actions/confirmation', controller.confirm);
  router.get('/:purchaseOrderId/actions/comments', controller.panel('comments'));
  router.get('/:purchaseOrderId/actions/ct', controller.panel('ct'));
  router.get('/:purchaseOrderId/actions/pieces', controller.panel('pieces'));
  router.get('/:purchaseOrderId/edit', controller.getEditor);
  router.get('/:purchaseOrderId/edit/products', controller.searchEditorProducts);
  router.get('/:purchaseOrderId/removal', controller.getRemoval);
  router.delete('/:purchaseOrderId', controller.remove);
  router.patch('/:purchaseOrderId', controller.saveEdition);
  router.get('/:purchaseOrderId', controller.getById);
  return router;
};
