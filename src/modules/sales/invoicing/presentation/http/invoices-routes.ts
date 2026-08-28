import { Router } from 'express';
import type { InvoicePanelKey } from '../../domain/repositories/invoice-panels-repository.js';
import type { InvoicesController } from './invoices-controller.js';

const panelRoutes: Array<[string, InvoicePanelKey]> = [
  ['actions/auxiliary', 'auxiliary'],
  ['actions/boxes', 'boxes'],
  ['actions/classifications', 'classifications'],
  ['actions/comments', 'comments'],
  ['actions/ct', 'ct'],
  ['actions/print', 'print'],
  ['actions/lots', 'lots'],
  ['actions/pieces', 'pieces'],
  ['actions/seal', 'seal'],
  ['summaries/ticket-to-invoice', 'ticket-to-invoice'],
  ['summaries/transfer', 'transfer'],
  ['summaries/edit-pieces', 'edit-pieces'],
  ['summaries/truck-settlement', 'truck-settlement'],
];

export const createInvoicesRouter = (controller: InvoicesController): Router => {
  const router = Router();
  router.get('/', controller.search);
  router.get('/first', controller.getFirst);
  router.get('/by-number/:invoiceNumber', controller.getByNumber);
  router.get('/:invoiceId/previous', controller.getPrevious);
  router.get('/:invoiceId/next', controller.getNext);
  panelRoutes.forEach(([path, key]) => router.get(`/:invoiceId/${path}`, controller.panel(key)));
  router.get('/:invoiceId', controller.getById);
  return router;
};
