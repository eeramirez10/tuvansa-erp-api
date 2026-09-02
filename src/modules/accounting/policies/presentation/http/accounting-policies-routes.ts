import { Router } from 'express';
import type { AccountingPoliciesController } from './accounting-policies-controller.js';

export const createAccountingPoliciesRouter = (controller: AccountingPoliciesController): Router => {
  const router = Router();
  router.get('/', controller.search);
  router.get('/by-number/:policyNumber', controller.getByNumberHandler);
  router.get('/:policyId/previous', controller.previous);
  router.get('/:policyId/next', controller.next);
  router.get('/:policyId/actions/classifications', controller.classifications);
  router.get('/:policyId', controller.getById);
  return router;
};
