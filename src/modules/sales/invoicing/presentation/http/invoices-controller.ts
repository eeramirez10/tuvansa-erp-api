import type { RequestHandler } from 'express';
import { z } from 'zod';
import type { GetFirstInvoice } from '../../application/use-cases/get-first-invoice.js';
import type { GetInvoice } from '../../application/use-cases/get-invoice.js';
import type { GetInvoiceByNumber } from '../../application/use-cases/get-invoice-by-number.js';
import type { GetInvoicePanel } from '../../application/use-cases/get-invoice-panel.js';
import type { NavigateInvoice } from '../../application/use-cases/navigate-invoice.js';
import type { SearchInvoices } from '../../application/use-cases/search-invoices.js';
import type { InvoicePanelKey } from '../../domain/repositories/invoice-panels-repository.js';

const invoiceParamsSchema = z.object({ invoiceId: z.coerce.number().int().positive() });
const invoiceNumberParamsSchema = z.object({ invoiceNumber: z.string().trim().min(1).max(20) });
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const searchSchema = z.object({
  q: z.string().trim().min(1).optional(),
  issuedAt: dateSchema.optional(),
  invoiceNumber: z.string().trim().min(1).max(20).optional(),
  orderNumber: z.string().trim().min(1).max(20).optional(),
  customerOrderNumber: z.string().trim().min(1).max(30).optional(),
  deliveryNote: z.string().trim().min(1).max(30).optional(),
  folio: z.string().trim().min(1).max(40).optional(),
  customerCode: z.string().trim().min(1).max(20).optional(),
  warehouseSeal: z.string().trim().min(1).max(40).optional(),
  amount: z.coerce.number().optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(25),
});

export class InvoicesController {
  constructor(
    private readonly getInvoice: GetInvoice,
    private readonly getInvoiceByNumber: GetInvoiceByNumber,
    private readonly getFirstInvoice: GetFirstInvoice,
    private readonly searchInvoices: SearchInvoices,
    private readonly navigateInvoice: NavigateInvoice,
    private readonly getInvoicePanel: GetInvoicePanel,
  ) {}

  search: RequestHandler = async (request, response, next) => {
    try {
      const query = searchSchema.parse(request.query);
      response.json(await this.searchInvoices.execute({
        ...(query.q === undefined ? {} : { query: query.q }),
        ...(query.issuedAt === undefined ? {} : { issuedAt: query.issuedAt }),
        ...(query.invoiceNumber === undefined ? {} : { invoiceNumber: query.invoiceNumber }),
        ...(query.orderNumber === undefined ? {} : { orderNumber: query.orderNumber }),
        ...(query.customerOrderNumber === undefined ? {} : { customerOrderNumber: query.customerOrderNumber }),
        ...(query.deliveryNote === undefined ? {} : { deliveryNote: query.deliveryNote }),
        ...(query.folio === undefined ? {} : { folio: query.folio }),
        ...(query.customerCode === undefined ? {} : { customerCode: query.customerCode }),
        ...(query.warehouseSeal === undefined ? {} : { warehouseSeal: query.warehouseSeal }),
        ...(query.amount === undefined ? {} : { amount: query.amount }),
        page: query.page,
        pageSize: query.pageSize,
      }));
    } catch (error) { next(error); }
  };

  getById: RequestHandler = async (request, response, next) => {
    try {
      const { invoiceId } = invoiceParamsSchema.parse(request.params);
      response.json({ data: await this.getInvoice.execute(invoiceId) });
    } catch (error) { next(error); }
  };

  getByNumber: RequestHandler = async (request, response, next) => {
    try {
      const { invoiceNumber } = invoiceNumberParamsSchema.parse(request.params);
      response.json({ data: await this.getInvoiceByNumber.execute(invoiceNumber) });
    } catch (error) { next(error); }
  };

  getFirst: RequestHandler = async (_request, response, next) => {
    try {
      response.json({ data: await this.getFirstInvoice.execute() });
    } catch (error) { next(error); }
  };

  getPrevious: RequestHandler = async (request, response, next) => {
    try {
      const { invoiceId } = invoiceParamsSchema.parse(request.params);
      response.json({ data: await this.navigateInvoice.execute(invoiceId, 'previous') });
    } catch (error) { next(error); }
  };

  getNext: RequestHandler = async (request, response, next) => {
    try {
      const { invoiceId } = invoiceParamsSchema.parse(request.params);
      response.json({ data: await this.navigateInvoice.execute(invoiceId, 'next') });
    } catch (error) { next(error); }
  };

  panel = (key: InvoicePanelKey): RequestHandler => async (request, response, next) => {
    try {
      const { invoiceId } = invoiceParamsSchema.parse(request.params);
      response.json(await this.getInvoicePanel.execute(invoiceId, key));
    } catch (error) { next(error); }
  };
}
