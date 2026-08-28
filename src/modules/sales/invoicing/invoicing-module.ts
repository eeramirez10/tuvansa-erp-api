import type { Router } from 'express';
import { GetFirstInvoice } from './application/use-cases/get-first-invoice.js';
import { GetInvoice } from './application/use-cases/get-invoice.js';
import { GetInvoiceByNumber } from './application/use-cases/get-invoice-by-number.js';
import { GetInvoicePanel } from './application/use-cases/get-invoice-panel.js';
import { NavigateInvoice } from './application/use-cases/navigate-invoice.js';
import { SearchInvoices } from './application/use-cases/search-invoices.js';
import { LegacyMysqlInvoicePanelsDataSource } from './infrastructure/datasources/legacy-mysql-invoice-panels-data-source.js';
import { LegacyMysqlInvoicesDataSource } from './infrastructure/datasources/legacy-mysql-invoices-data-source.js';
import { InvoicePanelsRepositoryImpl } from './infrastructure/repositories/invoice-panels-repository-impl.js';
import { InvoicesRepositoryImpl } from './infrastructure/repositories/invoices-repository-impl.js';
import { InvoicesController } from './presentation/http/invoices-controller.js';
import { createInvoicesRouter } from './presentation/http/invoices-routes.js';

export const createInvoicingModule = (): Router => {
  const repository = new InvoicesRepositoryImpl(new LegacyMysqlInvoicesDataSource());
  const panelsRepository = new InvoicePanelsRepositoryImpl(new LegacyMysqlInvoicePanelsDataSource());
  const controller = new InvoicesController(
    new GetInvoice(repository),
    new GetInvoiceByNumber(repository),
    new GetFirstInvoice(repository),
    new SearchInvoices(repository),
    new NavigateInvoice(repository),
    new GetInvoicePanel(panelsRepository),
  );
  return createInvoicesRouter(controller);
};
