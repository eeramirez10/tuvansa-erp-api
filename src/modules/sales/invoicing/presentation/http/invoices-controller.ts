import type { RequestHandler } from 'express';
import { z } from 'zod';
import type { CancelSalesRemission } from '../../application/use-cases/cancel-sales-remission.js';
import type { CreateInvoiceFromOrder } from '../../application/use-cases/create-invoice-from-order.js';
import type { EditInvoicePieces } from '../../application/use-cases/edit-invoice-pieces.js';
import type { GetFirstInvoice } from '../../application/use-cases/get-first-invoice.js';
import type { GetInvoice } from '../../application/use-cases/get-invoice.js';
import type { GetInvoiceByNumber } from '../../application/use-cases/get-invoice-by-number.js';
import type { GetInvoicePanel } from '../../application/use-cases/get-invoice-panel.js';
import type { NavigateInvoice } from '../../application/use-cases/navigate-invoice.js';
import type { SearchInvoices } from '../../application/use-cases/search-invoices.js';
import type { SimulateSalesStamping } from '../../application/use-cases/simulate-sales-stamping.js';
import type { InvoicePanelKey } from '../../domain/repositories/invoice-panels-repository.js';

const invoiceParamsSchema = z.object({ invoiceId: z.coerce.number().int().positive() });
const pieceParamsSchema = invoiceParamsSchema.extend({ lineId: z.coerce.number().int().positive() });
const pieceSchema = z.strictObject({
  expectedVersion: z.string().regex(/^[a-f0-9]{64}$/),
  requestKey: z.uuid(),
  value: z.string().max(24000).refine((value) => !value.includes('\0') && !/[\r\n]/.test(value), 'Valor de una línea'),
});
const cancellationSchema = z.strictObject({
  requestKey: z.uuid(), date: z.iso.date(), reason: z.string().trim().min(1).max(90), confirmed: z.literal(true), regenerateOrder: z.boolean(),
});
const invoiceNumberParamsSchema = z.object({ invoiceNumber: z.string().trim().min(1).max(20) });
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const orderNumberSchema = z.string().trim().min(1).max(15).toUpperCase();
const invoiceFromOrderSchema = z.strictObject({
  orderNumber: orderNumberSchema,
  requestKey: z.uuid(),
  revision: z.int().positive(),
  issuedAt: z.iso.date(),
  lines: z.array(z.strictObject({ orderLineId: z.int().positive(), quantity: z.number().positive() })).min(1),
});
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
    private readonly invoiceFromOrder: CreateInvoiceFromOrder,
    private readonly stamping: SimulateSalesStamping,
    private readonly cancellations: CancelSalesRemission,
    private readonly pieces: EditInvoicePieces,
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

  prepareFromOrder: RequestHandler = async (request, response, next) => {
    try {
      const number = orderNumberSchema.parse(request.query.orderNumber);
      response.set('Cache-Control', 'no-store').json({ data: await this.invoiceFromOrder.prepare(1, number) });
    } catch (error) { next(error); }
  };

  createFromOrder: RequestHandler = async (request, response, next) => {
    try {
      const result = await this.invoiceFromOrder.save(1, 0, invoiceFromOrderSchema.parse(request.body));
      response.status(201).json({ data: result });
    } catch (error) { next(error); }
  };

  prepareCancellation: RequestHandler = async (request, response, next) => {
    try {
      const { invoiceId } = invoiceParamsSchema.parse(request.params);
      response.set('Cache-Control', 'no-store').json({ data: await this.cancellations.prepare(1, invoiceId) });
    } catch (error) { next(error); }
  };

  cancelRemission: RequestHandler = async (request, response, next) => {
    try {
      const { invoiceId } = invoiceParamsSchema.parse(request.params);
      const result = await this.cancellations.save(1, 0, invoiceId, cancellationSchema.parse(request.body));
      response.status(201).json({ data: result });
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

  editPieces: RequestHandler = async (request, response, next) => {
    try {
      const { invoiceId, lineId } = pieceParamsSchema.parse(request.params);
      const edit = pieceSchema.parse(request.body);
      response.set('Cache-Control', 'no-store').json({ data: await this.pieces.execute(invoiceId, lineId, edit) });
    } catch (error) { next(error); }
  };

  simulateStamping: RequestHandler = async (request, response, next) => {
    try {
      const { invoiceId } = invoiceParamsSchema.parse(request.params);
      z.strictObject({}).parse(request.body ?? {});
      const result = await this.stamping.run(invoiceId);
      response.set('Cache-Control', 'no-store').json({ data: result });
    } catch (error) { next(error); }
  };
}
