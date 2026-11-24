import { Router } from 'express';
import type { CancelPurchaseReception } from '../../application/use-cases/cancel-purchase-reception.js';
import type { ReversePurchasePosting } from '../../application/use-cases/reverse-purchase-posting.js';
import { postingReversalHandlers, purchaseReceptionCancellationHandlers } from './posting-reversal-handlers.js';
import type { PurchaseReceptionsController } from './purchase-receptions-controller.js';
import type { PurchaseReceptionPiecesController } from './purchase-reception-pieces-controller.js';
import type { PurchaseReceptionCommentsController } from './purchase-reception-comments-controller.js';
import type { PurchaseReceptionDocumentationController } from './purchase-reception-documentation-controller.js';
import type { PurchaseReceptionSupplierChangeController } from './purchase-reception-supplier-change-controller.js';

export const createPurchaseReceptionsRouter = (controller: PurchaseReceptionsController, expenses: Router,
  reversals: ReversePurchasePosting, receiptCancellations: CancelPurchaseReception, pieces: PurchaseReceptionPiecesController,
  comments: PurchaseReceptionCommentsController, documentation: PurchaseReceptionDocumentationController,
  supplierChange: PurchaseReceptionSupplierChangeController): Router => {
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
  router.get('/:purchaseReceptionId/actions/comments', comments.get);
  router.patch('/:purchaseReceptionId/actions/comments', comments.save);
  router.get('/:purchaseReceptionId/actions/change-supplier', supplierChange.preview);
  router.get('/:purchaseReceptionId/actions/change-supplier/suppliers', supplierChange.suppliers);
  router.patch('/:purchaseReceptionId/actions/change-supplier', supplierChange.save);
  router.get('/:purchaseReceptionId/actions/document', documentation.preview);
  router.post('/:purchaseReceptionId/actions/document', documentation.save);
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
