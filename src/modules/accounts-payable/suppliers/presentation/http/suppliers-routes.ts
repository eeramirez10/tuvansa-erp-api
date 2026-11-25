import { Router } from 'express';
import type { ReversePurchasePosting } from '../../../../purchasing/purchase-receptions/application/use-cases/reverse-purchase-posting.js';
import { postingReversalHandlers } from '../../../../purchasing/purchase-receptions/presentation/http/posting-reversal-handlers.js';
import type { SupplierCatalogController } from './supplier-catalog-controller.js';
import type { SuppliersController } from './suppliers-controller.js';

export const createSuppliersRouter = (controller: SuppliersController, reversals: ReversePurchasePosting, catalog: SupplierCatalogController): Router => {
  const router = Router();
  const reversal = postingReversalHandlers(reversals, 'payment');

  router.get('/', controller.search);
  router.post('/', catalog.create);
  router.get('/first', controller.getFirst);
  router.get('/create', catalog.getCreate);
  router.get('/:supplierId/previous', controller.getPrevious);
  router.get('/:supplierId/next', controller.getNext);
  router.get('/:supplierId/actions/classifications', controller.getClassifications);
  router.patch('/:supplierId/actions/classifications', catalog.classify);
  router.get('/:supplierId/actions/block-status', controller.panel('block-status'));
  router.get('/:supplierId/actions/discounts', controller.panel('discounts'));
  router.get('/:supplierId/actions/events', controller.panel('events'));
  router.get('/:supplierId/actions/various', controller.panel('various'));
  router.get('/:supplierId/actions/contacts', controller.panel('contacts'));
  router.get('/:supplierId/balance', controller.panel('balance'));
  router.get('/:supplierId/movements', controller.panel('movements'));
  router.get('/:supplierId/payments/:receiptId', controller.preparePayment);
  router.post('/:supplierId/payments/:receiptId', controller.createPayment);
  router.get('/:supplierId/payments/:paymentId/reversal', reversal.prepare);
  router.post('/:supplierId/payments/:paymentId/reversal', reversal.save);
  router.get('/:supplierId/invoices', controller.panel('invoices'));
  router.get('/:supplierId/products/ordered', controller.panel('ordered-products'));
  router.get('/:supplierId/fill-rate', controller.panel('fill-rate'));
  router.get('/:supplierId/products/quoted', controller.panel('quoted-products'));
  router.get('/:supplierId/products/purchased', controller.panel('purchased-products'));
  router.get('/:supplierId/products/purchased-detail', controller.panel('purchased-products-detail'));
  router.get('/:supplierId/products/price-history', controller.panel('price-history'));
  router.get('/:supplierId/expenses/purchased', controller.panel('purchased-expenses'));
  router.get('/:supplierId/purchases/annual', controller.panel('annual-purchases'));
  router.get('/:supplierId/purchases/annual-summary', controller.panel('annual-purchases-summary'));
  router.get('/:supplierId/work-in-progress', controller.panel('work-in-progress'));
  router.get('/:supplierId/edit', catalog.getEdit);
  router.get('/:supplierId', controller.getById);
  router.patch('/:supplierId', catalog.update);
  router.delete('/:supplierId', catalog.remove);

  return router;
};
