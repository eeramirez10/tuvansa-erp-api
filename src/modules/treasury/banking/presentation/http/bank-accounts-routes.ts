import { Router } from 'express';
import type { BankAccountsController } from './bank-accounts-controller.js';
import type { BankCatalogWritesController } from './bank-catalog-writes-controller.js';
import type { BankSupplierExpensesController } from './bank-supplier-expenses-controller.js';

export const createBankAccountsRouter = (
  controller: BankAccountsController, catalog: BankCatalogWritesController, expenses: BankSupplierExpensesController,
): Router => {
  const router = Router();
  router.get('/', controller.search);
  router.post('/', catalog.create);
  router.get('/first', controller.getFirst);
  router.get('/create', catalog.getCreate);
  router.get('/by-code/:code', controller.getByCode);
  router.get('/:bankAccountId/previous', controller.getPrevious);
  router.get('/:bankAccountId/next', controller.getNext);
  router.get('/:bankAccountId/actions/movements', controller.panel('movements'));
  router.get('/:bankAccountId/actions/deposits', controller.panel('deposits'));
  router.get('/:bankAccountId/actions/payments', controller.panel('payments'));
  router.get('/:bankAccountId/actions/auxiliary', controller.panel('auxiliary'));
  router.get('/:bankAccountId/actions/reconciliation', controller.panel('reconciliation'));
  router.post('/:bankAccountId/actions/reconciliation', controller.reconcile);
  router.patch('/:bankAccountId/actions/reconciliation/transit', controller.setTransit);
  router.get('/:bankAccountId/actions/automatic-reconciliation', controller.panel('automatic-reconciliation'));
  router.get('/:bankAccountId/actions/general-ledger', controller.panel('general-ledger'));
  router.patch('/:bankAccountId/actions/general-ledger', controller.changeBudget(false));
  router.get('/:bankAccountId/actions/cost-center-ledger', controller.panel('cost-center-ledger'));
  router.patch('/:bankAccountId/actions/cost-center-ledger', controller.changeBudget(true));
  router.get('/:bankAccountId/actions/authorization-review', controller.panel('authorization-review'));
  router.patch('/:bankAccountId/actions/authorization-review', controller.review);
  router.get('/:bankAccountId/actions/classifiers', controller.panel('classifiers'));
  router.patch('/:bankAccountId/actions/classifiers', controller.classify);
  router.get('/:bankAccountId/actions/supplier-expenses', controller.panel('supplier-expenses'));
  router.get('/:bankAccountId/actions/supplier-expenses/capture', expenses.prepare);
  router.post('/:bankAccountId/actions/supplier-expenses', expenses.create);
  router.get('/:bankAccountId/actions/transfer', controller.panel('transfer'));
  router.get('/:bankAccountId/actions/transfer/capture', controller.prepareTransfer);
  router.post('/:bankAccountId/actions/transfer', controller.transfer);
  router.get('/:bankAccountId/actions/unapplied-auxiliary', controller.panel('unapplied-auxiliary'));
  router.get('/:bankAccountId/edit', catalog.getEdit);
  router.get('/:bankAccountId', controller.getById);
  router.patch('/:bankAccountId', catalog.update);
  router.delete('/:bankAccountId', catalog.remove);
  return router;
};
