import { Router } from 'express';
import type { PurchaseOrdersController } from './purchase-orders-controller.js';

export const createPurchaseOrdersRouter = (controller: PurchaseOrdersController): Router => {
  const router = Router();
  router.get('/', controller.search);
  router.get('/by-number/:purchaseOrderNumber', controller.getByNumberHandler);
  router.get('/:purchaseOrderId/previous', controller.previous);
  router.get('/:purchaseOrderId/next', controller.next);
  router.get('/:purchaseOrderId/actions/auxiliar', controller.panel('receipts'));
  router.get('/:purchaseOrderId/actions/classifications', controller.panel('classifications'));
  router.patch('/:purchaseOrderId/actions/classifications', controller.classify);
  router.get('/:purchaseOrderId/actions/comments', controller.panel('comments'));
  router.get('/:purchaseOrderId/actions/ct', controller.panel('ct'));
  router.get('/:purchaseOrderId/actions/pieces', controller.panel('pieces'));
  router.get('/:purchaseOrderId', controller.getById);
  return router;
};
