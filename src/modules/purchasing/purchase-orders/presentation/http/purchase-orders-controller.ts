import type { RequestHandler } from 'express';
import { z } from 'zod';
import type { GetPurchaseOrderByNumber } from '../../application/use-cases/get-purchase-order-by-number.js';
import type { GetPurchaseOrderPanel } from '../../application/use-cases/get-purchase-order-panel.js';
import type { GetPurchaseOrder } from '../../application/use-cases/get-purchase-order.js';
import type { NavigatePurchaseOrder } from '../../application/use-cases/navigate-purchase-order.js';
import type { SearchPurchaseOrders } from '../../application/use-cases/search-purchase-orders.js';
import type { PurchaseOrderPanelKey } from '../../domain/repositories/purchase-orders-repository.js';

const idParamsSchema = z.object({ purchaseOrderId: z.coerce.number().int().positive() });
const numberParamsSchema = z.object({ purchaseOrderNumber: z.string().trim().min(1).max(15) });
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const searchSchema = z.object({
  q: z.string().trim().min(1).optional(),
  orderNumber: z.string().trim().min(1).max(15).optional(),
  supplierOrderNumber: z.string().trim().min(1).max(30).optional(),
  supplierCode: z.string().trim().min(1).max(20).optional(),
  orderedAt: dateSchema.optional(),
  dueAt: dateSchema.optional(),
  agent: z.string().trim().min(1).max(10).optional(),
  documentType: z.coerce.number().int().refine((value) => value === 2 || value === 5).optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(25),
});

export class PurchaseOrdersController {
  constructor(
    private readonly getPurchaseOrder: GetPurchaseOrder,
    private readonly getByNumber: GetPurchaseOrderByNumber,
    private readonly searchPurchaseOrders: SearchPurchaseOrders,
    private readonly navigatePurchaseOrder: NavigatePurchaseOrder,
    private readonly getPanel: GetPurchaseOrderPanel,
  ) {}

  search: RequestHandler = async (request, response, next) => {
    try {
      const query = searchSchema.parse(request.query);
      response.json(await this.searchPurchaseOrders.execute({
        ...(query.q === undefined ? {} : { query: query.q }),
        ...(query.orderNumber === undefined ? {} : { orderNumber: query.orderNumber }),
        ...(query.supplierOrderNumber === undefined ? {} : { supplierOrderNumber: query.supplierOrderNumber }),
        ...(query.supplierCode === undefined ? {} : { supplierCode: query.supplierCode }),
        ...(query.orderedAt === undefined ? {} : { orderedAt: query.orderedAt }),
        ...(query.dueAt === undefined ? {} : { dueAt: query.dueAt }),
        ...(query.agent === undefined ? {} : { agent: query.agent }),
        ...(query.documentType === undefined ? {} : { documentType: query.documentType }),
        page: query.page,
        pageSize: query.pageSize,
      }));
    } catch (error) { next(error); }
  };

  getById: RequestHandler = async (request, response, next) => {
    try {
      const { purchaseOrderId } = idParamsSchema.parse(request.params);
      response.json({ data: await this.getPurchaseOrder.execute(purchaseOrderId) });
    } catch (error) { next(error); }
  };

  getByNumberHandler: RequestHandler = async (request, response, next) => {
    try {
      const { purchaseOrderNumber } = numberParamsSchema.parse(request.params);
      response.json({ data: await this.getByNumber.execute(purchaseOrderNumber) });
    } catch (error) { next(error); }
  };

  previous: RequestHandler = async (request, response, next) => {
    try {
      const { purchaseOrderId } = idParamsSchema.parse(request.params);
      response.json({ data: await this.navigatePurchaseOrder.execute(purchaseOrderId, 'previous') });
    } catch (error) { next(error); }
  };

  next: RequestHandler = async (request, response, next) => {
    try {
      const { purchaseOrderId } = idParamsSchema.parse(request.params);
      response.json({ data: await this.navigatePurchaseOrder.execute(purchaseOrderId, 'next') });
    } catch (error) { next(error); }
  };

  panel = (key: PurchaseOrderPanelKey): RequestHandler => async (request, response, next) => {
    try {
      const { purchaseOrderId } = idParamsSchema.parse(request.params);
      response.json(await this.getPanel.execute(purchaseOrderId, key));
    } catch (error) { next(error); }
  };
}
