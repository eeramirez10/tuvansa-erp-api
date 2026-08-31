import { Router } from 'express';
import type { SuppliersController } from './suppliers-controller.js';

export const createSuppliersRouter = (controller: SuppliersController): Router => {
  const router = Router();

  router.get('/', controller.search);
  router.get('/first', controller.getFirst);
  router.get('/:supplierId/previous', controller.getPrevious);
  router.get('/:supplierId/next', controller.getNext);
  router.get('/:supplierId/actions/classifications', controller.getClassifications);
  router.get('/:supplierId/actions/block-status', controller.panel('block-status'));
  router.get('/:supplierId/actions/discounts', controller.panel('discounts'));
  router.get('/:supplierId/actions/events', controller.panel('events'));
  router.get('/:supplierId/actions/various', controller.panel('various'));
  router.get('/:supplierId/actions/contacts', controller.panel('contacts'));
  router.get('/:supplierId/balance', controller.panel('balance'));
  router.get('/:supplierId/movements', controller.panel('movements'));
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
  router.get('/:supplierId', controller.getById);

  return router;
};
