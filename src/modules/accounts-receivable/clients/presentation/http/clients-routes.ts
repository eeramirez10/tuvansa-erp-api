import { Router } from 'express';
import type { ClientsController } from './clients-controller.js';

export const createClientsRouter = (controller: ClientsController): Router => {
  const router = Router();

  router.get('/', controller.search);
  router.get('/:clientCode', controller.getByCode);

  return router;
};
