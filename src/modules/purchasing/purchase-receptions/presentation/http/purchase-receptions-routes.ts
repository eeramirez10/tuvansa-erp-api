import { Router } from 'express';
import type { PurchaseReceptionsController } from './purchase-receptions-controller.js';

export const createPurchaseReceptionsRouter = (controller: PurchaseReceptionsController, expenses: Router): Router => {
  const router = Router();
  router.use('/general-expenses', expenses);
  router.get('/', controller.search);
  router.get('/create', controller.prepare);
  router.post('/', controller.create);
  router.get('/by-number/:purchaseReceptionNumber', controller.getByNumberHandler);
  router.get('/:purchaseReceptionId/previous', controller.previous);
  router.get('/:purchaseReceptionId/next', controller.next);
  router.get('/:purchaseReceptionId/actions/auxiliary', controller.panel('auxiliary'));
  router.get('/:purchaseReceptionId/actions/classifications', controller.panel('classifications'));
  router.get('/:purchaseReceptionId', controller.getById);
  return router;
};
