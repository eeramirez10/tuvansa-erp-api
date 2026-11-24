import type { Router } from 'express';
import { LegacyMysqlPurchaseOrderEditDataSource } from '../purchase-orders/infrastructure/datasources/legacy-mysql-purchase-order-edit-data-source.js';
import { LegacyMysqlPurchaseOrdersDataSource } from '../purchase-orders/infrastructure/datasources/legacy-mysql-purchase-orders-data-source.js';
import { PostgresPurchaseOrderEdits } from '../purchase-orders/infrastructure/datasources/postgres-purchase-order-edits.js';
import { CancelPurchaseReception } from './application/use-cases/cancel-purchase-reception.js';
import { CreatePurchaseExpenses } from './application/use-cases/create-purchase-expenses.js';
import { CreatePurchaseReception } from './application/use-cases/create-purchase-reception.js';
import { GetPurchaseReceptionByNumber } from './application/use-cases/get-purchase-reception-by-number.js';
import { GetPurchaseReceptionPanel } from './application/use-cases/get-purchase-reception-panel.js';
import { GetPurchaseReception } from './application/use-cases/get-purchase-reception.js';
import { ManagePurchaseReceptionPieces } from './application/use-cases/manage-purchase-reception-pieces.js';
import { NavigatePurchaseReception } from './application/use-cases/navigate-purchase-reception.js';
import { ReversePurchasePosting } from './application/use-cases/reverse-purchase-posting.js';
import { SearchPurchaseReceptions } from './application/use-cases/search-purchase-receptions.js';
import { LegacyMysqlPurchaseReceptionsDataSource } from './infrastructure/datasources/legacy-mysql-purchase-receptions-data-source.js';
import { HybridPurchaseReceptionsDataSource } from './infrastructure/datasources/hybrid-purchase-receptions-data-source.js';
import { MysqlHistoricalReceptionCancellationSource } from './infrastructure/datasources/mysql-historical-reception-cancellation-source.js';
import { MysqlPostingReversalReferences } from './infrastructure/datasources/mysql-posting-reversal-references.js';
import { MysqlPurchaseExpenseReferences } from './infrastructure/datasources/mysql-purchase-expense-references.js';
import { MysqlPurchaseReceptionPieceNativeSource } from './infrastructure/datasources/mysql-purchase-reception-piece-native-source.js';
import { MysqlPurchaseReceptionWriteReferences } from './infrastructure/datasources/mysql-purchase-reception-write-references.js';
import { PostgresPurchaseReceptionWrites } from './infrastructure/datasources/postgres-purchase-reception-writes.js';
import { PostgresPurchaseReceptionCancellations } from './infrastructure/datasources/postgres-purchase-reception-cancellations.js';
import { PostgresPurchaseReceptionPieces } from './infrastructure/datasources/postgres-purchase-reception-pieces.js';
import { PostgresPurchaseExpenses } from './infrastructure/datasources/postgres-purchase-expenses.js';
import { PostgresPurchasePostingReversals } from './infrastructure/datasources/postgres-purchase-posting-reversals.js';
import { PurchaseReceptionsRepositoryImpl } from './infrastructure/repositories/purchase-receptions-repository-impl.js';
import { PurchaseReceptionsController } from './presentation/http/purchase-receptions-controller.js';
import { createPurchaseExpenseRouter } from './presentation/http/purchase-expense-routes.js';
import { PurchaseReceptionPiecesController } from './presentation/http/purchase-reception-pieces-controller.js';
import { createPurchaseReceptionsRouter } from './presentation/http/purchase-receptions-routes.js';

export const createPurchaseReceptionsModule = (): Router => {
  const legacyReceptions = new LegacyMysqlPurchaseReceptionsDataSource();
  const repository = new PurchaseReceptionsRepositoryImpl(new HybridPurchaseReceptionsDataSource(legacyReceptions));
  const legacyOrders = new LegacyMysqlPurchaseOrdersDataSource();
  const edits = new PostgresPurchaseOrderEdits();
  const capture = new LegacyMysqlPurchaseOrderEditDataSource(legacyOrders);
  const receptionReferences = new MysqlPurchaseReceptionWriteReferences(capture, edits);
  const controller = new PurchaseReceptionsController(
    new GetPurchaseReception(repository),
    new GetPurchaseReceptionByNumber(repository),
    new SearchPurchaseReceptions(repository),
    new NavigatePurchaseReception(repository),
    new GetPurchaseReceptionPanel(repository),
    new CreatePurchaseReception(receptionReferences, new PostgresPurchaseReceptionWrites(edits)),
    async (number) => (await edits.findLocalByNumber(number))?.order.identity.id ?? (await legacyOrders.findByNumber(number))?.identity.id,
  );
  const expenses = new CreatePurchaseExpenses(new MysqlPurchaseExpenseReferences(), new PostgresPurchaseExpenses());
  const fiscal = new MysqlPostingReversalReferences();
  const reversals = new ReversePurchasePosting(new PostgresPurchasePostingReversals(), fiscal);
  const historical = new MysqlHistoricalReceptionCancellationSource(legacyReceptions);
  const receiptCancellations = new CancelPurchaseReception(
    new PostgresPurchaseReceptionCancellations(edits, undefined, undefined, historical), receptionReferences, fiscal,
  );
  const pieces = new PurchaseReceptionPiecesController(
    new ManagePurchaseReceptionPieces(new PostgresPurchaseReceptionPieces(new MysqlPurchaseReceptionPieceNativeSource())),
  );
  return createPurchaseReceptionsRouter(controller, createPurchaseExpenseRouter(expenses), reversals, receiptCancellations, pieces);
};
