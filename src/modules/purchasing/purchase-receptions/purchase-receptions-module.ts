import type { Router } from 'express';
import { LegacyMysqlPurchaseOrderEditDataSource } from '../purchase-orders/infrastructure/datasources/legacy-mysql-purchase-order-edit-data-source.js';
import { LegacyMysqlPurchaseOrdersDataSource } from '../purchase-orders/infrastructure/datasources/legacy-mysql-purchase-orders-data-source.js';
import { PostgresPurchaseOrderEdits } from '../purchase-orders/infrastructure/datasources/postgres-purchase-order-edits.js';
import { CreatePurchaseExpenses } from './application/use-cases/create-purchase-expenses.js';
import { CreatePurchaseReception } from './application/use-cases/create-purchase-reception.js';
import { GetPurchaseReceptionByNumber } from './application/use-cases/get-purchase-reception-by-number.js';
import { GetPurchaseReceptionPanel } from './application/use-cases/get-purchase-reception-panel.js';
import { GetPurchaseReception } from './application/use-cases/get-purchase-reception.js';
import { NavigatePurchaseReception } from './application/use-cases/navigate-purchase-reception.js';
import { ReversePurchasePosting } from './application/use-cases/reverse-purchase-posting.js';
import { SearchPurchaseReceptions } from './application/use-cases/search-purchase-receptions.js';
import { LegacyMysqlPurchaseReceptionsDataSource } from './infrastructure/datasources/legacy-mysql-purchase-receptions-data-source.js';
import { HybridPurchaseReceptionsDataSource } from './infrastructure/datasources/hybrid-purchase-receptions-data-source.js';
import { MysqlPostingReversalReferences } from './infrastructure/datasources/mysql-posting-reversal-references.js';
import { MysqlPurchaseExpenseReferences } from './infrastructure/datasources/mysql-purchase-expense-references.js';
import { MysqlPurchaseReceptionWriteReferences } from './infrastructure/datasources/mysql-purchase-reception-write-references.js';
import { PostgresPurchaseReceptionWrites } from './infrastructure/datasources/postgres-purchase-reception-writes.js';
import { PostgresPurchaseExpenses } from './infrastructure/datasources/postgres-purchase-expenses.js';
import { PostgresPurchasePostingReversals } from './infrastructure/datasources/postgres-purchase-posting-reversals.js';
import { PurchaseReceptionsRepositoryImpl } from './infrastructure/repositories/purchase-receptions-repository-impl.js';
import { PurchaseReceptionsController } from './presentation/http/purchase-receptions-controller.js';
import { createPurchaseExpenseRouter } from './presentation/http/purchase-expense-routes.js';
import { createPurchaseReceptionsRouter } from './presentation/http/purchase-receptions-routes.js';

export const createPurchaseReceptionsModule = (): Router => {
  const repository = new PurchaseReceptionsRepositoryImpl(new HybridPurchaseReceptionsDataSource(new LegacyMysqlPurchaseReceptionsDataSource()));
  const legacyOrders = new LegacyMysqlPurchaseOrdersDataSource();
  const edits = new PostgresPurchaseOrderEdits();
  const capture = new LegacyMysqlPurchaseOrderEditDataSource(legacyOrders);
  const controller = new PurchaseReceptionsController(
    new GetPurchaseReception(repository),
    new GetPurchaseReceptionByNumber(repository),
    new SearchPurchaseReceptions(repository),
    new NavigatePurchaseReception(repository),
    new GetPurchaseReceptionPanel(repository),
    new CreatePurchaseReception(new MysqlPurchaseReceptionWriteReferences(capture, edits), new PostgresPurchaseReceptionWrites(edits)),
    async (number) => (await edits.findLocalByNumber(number))?.order.identity.id ?? (await legacyOrders.findByNumber(number))?.identity.id,
  );
  const expenses = new CreatePurchaseExpenses(new MysqlPurchaseExpenseReferences(), new PostgresPurchaseExpenses());
  const reversals = new ReversePurchasePosting(new PostgresPurchasePostingReversals(), new MysqlPostingReversalReferences());
  return createPurchaseReceptionsRouter(controller, createPurchaseExpenseRouter(expenses), reversals);
};
