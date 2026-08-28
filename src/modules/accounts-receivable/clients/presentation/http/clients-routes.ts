import { Router } from 'express';
import type { ClientsController } from './clients-controller.js';

export const createClientsRouter = (controller: ClientsController): Router => {
  const router = Router();

  router.get('/', controller.search);
  router.post('/', controller.create);
  router.get('/first', controller.getFirstActive);
  router.get('/:clientId/previous', controller.getPrevious);
  router.get('/:clientId/next', controller.getNext);
  router.get('/:clientId/balance', controller.getBalance);
  router.get('/:clientId/movements', controller.getMovements);
  router.get('/:clientId/invoices', controller.getInvoices);
  router.get('/:clientId/orders', controller.getOrders);
  router.get('/:clientId/products/ordered', controller.getOrderedProducts);
  router.get('/:clientId/products/quoted', controller.getQuotedProducts);
  router.get('/:clientId/products/sold', controller.getSoldProducts);
  router.get('/:clientId/products/sold-detail', controller.getSoldProductDetails);
  router.get('/:clientId/sales/annual', controller.getAnnualSales);
  router.get('/:clientId/sales/annual-summary', controller.getAnnualSalesSummary);
  router.get('/:clientId/sales/by-branch', controller.getSalesByBranch);
  router.get('/:clientId/sales/edi', controller.getEdiSales);
  router.get('/:clientId/work-in-progress', controller.getWorkInProgress);
  router.get('/:clientId/ct/products/ordered', controller.getCtOrderedProducts);
  router.get('/:clientId/ct/products/sold', controller.getCtSoldProducts);
  router.get('/:clientId/ct/work-in-progress', controller.getCtWorkInProgress);
  router.get('/:clientId/actions/classifications', controller.getClassifications);
  router.get('/:clientId/actions/destinations', controller.getDestinations);
  router.get('/:clientId/actions/block-status', controller.getBlockStatus);
  router.get('/:clientId/actions/discounts', controller.getDiscounts);
  router.get('/:clientId/actions/events', controller.getEvents);
  router.get('/:clientId/actions/branches', controller.getBranches);
  router.get('/:clientId/actions/photo', controller.getPhoto);
  router.get('/:clientId/actions/contacts', controller.getContacts);
  router.get('/:clientId', controller.getById);
  router.patch('/:clientId', controller.update);
  router.delete('/:clientId', controller.delete);

  return router;
};
