import { Router } from 'express';
import type { ReversePurchasePosting } from '../../../../purchasing/purchase-receptions/application/use-cases/reverse-purchase-posting.js';
import { postingReversalHandlers } from '../../../../purchasing/purchase-receptions/presentation/http/posting-reversal-handlers.js';
import type { SupplierCatalogController } from './supplier-catalog-controller.js';
import type { SuppliersController } from './suppliers-controller.js';
import type { GroupSupplierBalance } from '../../application/use-cases/group-supplier-balance.js';
import { z } from 'zod';

const position = z.strictObject({ id: z.int().positive(), revision: z.string().regex(/^[a-f0-9]{64}$/) });
const groupBody = z.strictObject({
  target: position, sources: z.array(position).min(1), requestKey: z.uuid().transform((value) => value.toLowerCase()),
});

export const createSuppliersRouter = (controller: SuppliersController, reversals: ReversePurchasePosting, catalog: SupplierCatalogController,
  grouping: GroupSupplierBalance): Router => {
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
  router.post('/:supplierId/actions/events', catalog.addActivity('events'));
  router.patch('/:supplierId/actions/events/:activityId', catalog.changeEvent);
  router.delete('/:supplierId/actions/events/:activityId', catalog.removeActivity('events'));
  router.get('/:supplierId/actions/various', controller.panel('various'));
  router.patch('/:supplierId/actions/various', catalog.saveVarious);
  router.get('/:supplierId/actions/contacts', controller.panel('contacts'));
  router.post('/:supplierId/actions/contacts', catalog.addActivity('contacts'));
  router.delete('/:supplierId/actions/contacts/:activityId', catalog.removeActivity('contacts'));
  router.get('/:supplierId/balance', controller.panel('balance'));
  router.post('/:supplierId/balance/grouping', async (request, response) => {
    const supplierId = z.coerce.number().int().positive().parse(request.params.supplierId);
    response.status(201).json({ data: await grouping.execute(supplierId, groupBody.parse(request.body)) });
  });
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
