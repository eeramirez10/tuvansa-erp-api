import { Router } from 'express';
import type { BankAccountsController } from './bank-accounts-controller.js';

export const createBankAccountsRouter = (controller: BankAccountsController): Router => {
  const router = Router();
  router.get('/', controller.search);
  router.get('/first', controller.getFirst);
  router.get('/by-code/:code', controller.getByCode);
  router.get('/:bankAccountId/previous', controller.getPrevious);
  router.get('/:bankAccountId/next', controller.getNext);
  router.get('/:bankAccountId/actions/movements', controller.panel('movements'));
  router.get('/:bankAccountId/actions/deposits', controller.panel('deposits'));
  router.get('/:bankAccountId/actions/payments', controller.panel('payments'));
  router.get('/:bankAccountId/actions/auxiliary', controller.panel('auxiliary'));
  router.get('/:bankAccountId/actions/reconciliation', controller.panel('reconciliation'));
  router.get('/:bankAccountId/actions/automatic-reconciliation', controller.panel('automatic-reconciliation'));
  router.get('/:bankAccountId/actions/general-ledger', controller.panel('general-ledger'));
  router.get('/:bankAccountId/actions/cost-center-ledger', controller.panel('cost-center-ledger'));
  router.get('/:bankAccountId/actions/authorization-review', controller.panel('authorization-review'));
  router.get('/:bankAccountId/actions/classifiers', controller.panel('classifiers'));
  router.get('/:bankAccountId/actions/supplier-expenses', controller.panel('supplier-expenses'));
  router.get('/:bankAccountId/actions/transfer', controller.panel('transfer'));
  router.get('/:bankAccountId/actions/unapplied-auxiliary', controller.panel('unapplied-auxiliary'));
  router.get('/:bankAccountId', controller.getById);
  return router;
};
