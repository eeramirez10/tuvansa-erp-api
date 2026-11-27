import { Router } from 'express';
import { NotFoundError } from '../../../shared/domain/errors/not-found-error.js';
import { customerScope } from '../../../shared/infrastructure/http/customer-scope.js';
import { env } from '../../../config/env.js';
import { postgresConfigured } from '../../../shared/infrastructure/database/postgres-pool.js';
import { MysqlPostingReversalReferences } from '../../purchasing/purchase-receptions/infrastructure/datasources/mysql-posting-reversal-references.js';
import { CancelSalesRemission } from './application/use-cases/cancel-sales-remission.js';
import { ConvertSalesTicket } from './application/use-cases/convert-sales-ticket.js';
import { CreateInvoiceFromOrder } from './application/use-cases/create-invoice-from-order.js';
import { EditInvoicePieces } from './application/use-cases/edit-invoice-pieces.js';
import { GetFirstInvoice } from './application/use-cases/get-first-invoice.js';
import { GetInvoice } from './application/use-cases/get-invoice.js';
import { GetInvoiceByNumber } from './application/use-cases/get-invoice-by-number.js';
import { GetInvoicePanel } from './application/use-cases/get-invoice-panel.js';
import { NavigateInvoice } from './application/use-cases/navigate-invoice.js';
import { SearchInvoices } from './application/use-cases/search-invoices.js';
import { SimulateSalesStamping } from './application/use-cases/simulate-sales-stamping.js';
import { InvoicePanelsWithSalesRemissionsDataSource } from './infrastructure/datasources/invoice-panels-with-sales-remissions-data-source.js';
import { InvoicesWithSalesRemissionsDataSource, readSalesRemissionInvoice } from './infrastructure/datasources/invoices-with-sales-remissions-data-source.js';
import { LegacyMysqlInvoicePanelsDataSource } from './infrastructure/datasources/legacy-mysql-invoice-panels-data-source.js';
import { LegacyMysqlInvoicesDataSource } from './infrastructure/datasources/legacy-mysql-invoices-data-source.js';
import { MysqlHistoricalSalesRemissionCancellationSource } from './infrastructure/datasources/mysql-historical-sales-remission-cancellation-source.js';
import { MysqlInvoiceFromOrderReferences } from './infrastructure/datasources/mysql-invoice-from-order-references.js';
import { mexicoSalesTicketConversionSettings } from './infrastructure/datasources/mysql-sales-ticket-conversion-references.js';
import { isLocalSalesRemissionId, PostgresSalesRemissions } from './infrastructure/datasources/postgres-sales-remissions.js';
import { PostgresInvoicePieces } from './infrastructure/datasources/postgres-invoice-pieces.js';
import { PostgresSalesRemissionCancellations } from './infrastructure/datasources/postgres-sales-remission-cancellations.js';
import { PostgresSalesStampingSimulations } from './infrastructure/datasources/postgres-sales-stamping-simulations.js';
import { PostgresSalesTicketConversions } from './infrastructure/datasources/postgres-sales-ticket-conversions.js';
import { InvoicePanelsRepositoryImpl } from './infrastructure/repositories/invoice-panels-repository-impl.js';
import { InvoicesRepositoryImpl } from './infrastructure/repositories/invoices-repository-impl.js';
import { InvoicesController } from './presentation/http/invoices-controller.js';
import { createInvoicesRouter } from './presentation/http/invoices-routes.js';
import { createInvoiceTransferRouter } from './presentation/http/invoice-transfer-routes.js';
import { webAccess } from '../../general-data/users/users-module.js';
import { PostgresInvoiceTransfers } from './infrastructure/datasources/postgres-invoice-transfers.js';

export const createInvoicingModule = (): Router => {
  const pieces = new PostgresInvoicePieces();
  const conversion = new ConvertSalesTicket(new PostgresSalesTicketConversions(), mexicoSalesTicketConversionSettings);
  const repository = new InvoicesRepositoryImpl(new InvoicesWithSalesRemissionsDataSource(new LegacyMysqlInvoicesDataSource()), pieces);
  const stamping = new SimulateSalesStamping(
    new PostgresSalesStampingSimulations(),
    async (id) => isLocalSalesRemissionId(id) ? (await readSalesRemissionInvoice(id))?.invoice ?? null : null,
    () => env.NODE_ENV !== 'production' && postgresConfigured(),
  );
  const panels = new InvoicePanelsWithSalesRemissionsDataSource(new LegacyMysqlInvoicePanelsDataSource(), stamping, pieces, conversion);
  const panelsRepository = new InvoicePanelsRepositoryImpl(panels);
  const controller = new InvoicesController(
    new GetInvoice(repository),
    new GetInvoiceByNumber(repository),
    new GetFirstInvoice(repository),
    new SearchInvoices(repository),
    new NavigateInvoice(repository),
    new GetInvoicePanel(panelsRepository),
    new CreateInvoiceFromOrder(new PostgresSalesRemissions(), new MysqlInvoiceFromOrderReferences()),
    stamping,
    new CancelSalesRemission(new PostgresSalesRemissionCancellations(undefined, undefined, undefined,
      new MysqlHistoricalSalesRemissionCancellationSource()), new MysqlPostingReversalReferences()),
    new EditInvoicePieces(pieces, (id) => panels.readPieceLines(id)),
    conversion,
  );
  const router = Router();
  router.use(async (request, _response, next) => {
    if (customerScope.getStore()) {
      const id = Number(decodeURIComponent(request.path).split('/')[1]);
      if (Number.isSafeInteger(id) && id > 0 && !(await repository.findById(id))) throw new NotFoundError('Factura');
    }
    next();
  });
  router.use(createInvoiceTransferRouter(new PostgresInvoiceTransfers(), token => webAccess.invoiceTransferActor(token)));
  return router.use(createInvoicesRouter(controller));
};
