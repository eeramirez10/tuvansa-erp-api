import { Router } from 'express';
import type { OrderPanelKey } from '../../domain/repositories/order-panels-repository.js';
import type { OrdersController } from './orders-controller.js';

const panelRoutes: Array<[string, OrderPanelKey]> = [
  ['actions/assign-all', 'assign-all'], ['actions/authorize', 'authorize'],
  ['actions/auxiliar', 'invoices'], ['actions/boxes', 'boxes'],
  ['actions/classifications', 'classifications'], ['actions/comments', 'comments'],
  ['actions/quote-conversion', 'quote-conversion'], ['actions/duplicate', 'duplicate'],
  ['actions/labels', 'labels'], ['actions/print', 'print'], ['actions/monarch', 'monarch'],
  ['actions/pieces', 'pieces'], ['actions/transfer', 'transfer'],
  ['secondary-actions/assign-ct', 'assign-ct'], ['secondary-actions/consolidate', 'consolidate'],
  ['secondary-actions/ct', 'ct'], ['secondary-actions/split-ct', 'split-ct'],
  ['secondary-actions/export', 'export'], ['secondary-actions/purchase-order', 'purchase-order'],
  ['secondary-actions/split', 'split'], ['secondary-actions/branch', 'branch'],
  ['secondary-actions/wip', 'wip'],
];

export const createOrdersRouter = (controller: OrdersController): Router => {
  const router = Router();
  router.get('/', controller.search);
  router.post('/', controller.create);
  router.get('/:orderId/previous', controller.getPrevious);
  router.get('/:orderId/next', controller.getNext);
  panelRoutes.forEach(([path, key]) => router.get(`/:orderId/${path}`, controller.panel(key)));
  router.get('/:orderId', controller.getById);
  router.patch('/:orderId', controller.update);
  router.delete('/:orderId', controller.delete);
  return router;
};
