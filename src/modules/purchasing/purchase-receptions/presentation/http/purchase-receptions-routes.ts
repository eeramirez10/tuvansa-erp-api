import { Router } from 'express';
import type { CancelPurchaseReception } from '../../application/use-cases/cancel-purchase-reception.js';
import type { ReversePurchasePosting } from '../../application/use-cases/reverse-purchase-posting.js';
import { postingReversalHandlers, purchaseReceptionCancellationHandlers } from './posting-reversal-handlers.js';
import type { PurchaseReceptionsController } from './purchase-receptions-controller.js';
import type { PurchaseReceptionPiecesController } from './purchase-reception-pieces-controller.js';

export const createPurchaseReceptionsRouter = (controller: PurchaseReceptionsController, expenses: Router,
  reversals: ReversePurchasePosting, receiptCancellations: CancelPurchaseReception, pieces: PurchaseReceptionPiecesController): Router => {
  const router = Router();
  const cancellation = postingReversalHandlers(reversals, 'expense');
  const cancelReceipt = purchaseReceptionCancellationHandlers(receiptCancellations);
  router.use('/general-expenses', expenses);
  router.get('/', controller.search);
  router.get('/create', controller.prepare);
  router.post('/', controller.create);
  router.get('/by-number/:purchaseReceptionNumber', controller.getByNumberHandler);
  router.get('/:purchaseReceptionId/previous', controller.previous);
  router.get('/:purchaseReceptionId/next', controller.next);
  router.get('/:purchaseReceptionId/actions/auxiliary', controller.panel('auxiliary'));
  router.get('/:purchaseReceptionId/actions/classifications', controller.panel('classifications'));
  router.get('/:purchaseReceptionId/actions/pedimento', controller.panel('pedimento'));
  router.get('/:purchaseReceptionId/actions/pieces', controller.panel('pieces'));
  router.get('/:purchaseReceptionId/actions/pieces/lines/:lineId', pieces.prepare);
  router.post('/:purchaseReceptionId/actions/pieces/lines/:lineId', pieces.add);
  router.patch('/:purchaseReceptionId/actions/pieces/lines/:lineId', pieces.edit);
  router.patch('/:purchaseReceptionId/actions/pieces/:pieceId/serial', pieces.updateSerial);
  router.get('/:purchaseReceptionId/actions/cancel-expense', cancellation.prepare);
  router.post('/:purchaseReceptionId/actions/cancel-expense', cancellation.save);
  router.get('/:purchaseReceptionId/actions/cancel-reception', cancelReceipt.prepare);
  router.post('/:purchaseReceptionId/actions/cancel-reception', cancelReceipt.save);
  router.get('/:purchaseReceptionId', controller.getById);
  return router;
};
