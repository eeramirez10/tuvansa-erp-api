import { Router } from 'express';
import type { ReversePurchasePosting } from '../../application/use-cases/reverse-purchase-posting.js';
import { postingReversalHandlers } from './posting-reversal-handlers.js';
import type { PurchaseReceptionsController } from './purchase-receptions-controller.js';

export const createPurchaseReceptionsRouter = (controller: PurchaseReceptionsController, expenses: Router, reversals: ReversePurchasePosting): Router => {
  const router = Router();
  const cancellation = postingReversalHandlers(reversals, 'expense');
  router.use('/general-expenses', expenses);
  router.get('/', controller.search);
  router.get('/create', controller.prepare);
  router.post('/', controller.create);
  router.get('/by-number/:purchaseReceptionNumber', controller.getByNumberHandler);
  router.get('/:purchaseReceptionId/previous', controller.previous);
  router.get('/:purchaseReceptionId/next', controller.next);
  router.get('/:purchaseReceptionId/actions/auxiliary', controller.panel('auxiliary'));
  router.get('/:purchaseReceptionId/actions/classifications', controller.panel('classifications'));
  router.get('/:purchaseReceptionId/actions/cancel-expense', cancellation.prepare);
  router.post('/:purchaseReceptionId/actions/cancel-expense', cancellation.save);
  router.get('/:purchaseReceptionId', controller.getById);
  return router;
};
