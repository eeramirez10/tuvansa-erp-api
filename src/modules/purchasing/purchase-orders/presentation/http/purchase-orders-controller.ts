import type { RequestHandler } from 'express';
import { z } from 'zod';
import type { GetPurchaseOrderByNumber } from '../../application/use-cases/get-purchase-order-by-number.js';
import type { GetPurchaseOrderPanel } from '../../application/use-cases/get-purchase-order-panel.js';
import type { GetPurchaseOrder } from '../../application/use-cases/get-purchase-order.js';
import type { NavigatePurchaseOrder } from '../../application/use-cases/navigate-purchase-order.js';
import type { SearchPurchaseOrders } from '../../application/use-cases/search-purchase-orders.js';
import type { UpdatePurchaseOrderClassifications } from '../../application/use-cases/update-purchase-order-classifications.js';
import type { EditPurchaseOrder } from '../../application/use-cases/edit-purchase-order.js';
import type { CreatePurchaseOrder } from '../../application/use-cases/create-purchase-order.js';
import type { RemovePurchaseOrder } from '../../application/use-cases/remove-purchase-order.js';
import type { ConfirmPurchaseOrder } from '../../application/use-cases/confirm-purchase-order.js';
import type { PurchaseOrderPanelKey } from '../../domain/repositories/purchase-orders-repository.js';

const idParamsSchema = z.object({ purchaseOrderId: z.coerce.number().int().positive() });
const numberParamsSchema = z.object({ purchaseOrderNumber: z.string().trim().min(1).max(15) });
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const classificationSchema = z.object({
  current: z.array(z.string().max(16)).length(9),
  revision: z.number().int().min(0).max(2147483647),
}).strict();
const scaledNumber = (decimals: number) => z.number().refine((value) => {
  const scaled = value * 10 ** decimals;
  return Number.isSafeInteger(Math.round(scaled)) &&
    Math.abs(scaled - Math.round(scaled)) <= Math.max(1, Math.abs(scaled)) * Number.EPSILON * 4;
}, `Se esperan hasta ${decimals} decimales en un rango seguro.`);
const lineSchema = z.object({
  id: z.number().int().positive().nullable(),
  productCode: z.string().trim().max(13).toUpperCase(),
  quantity: scaledNumber(3),
  unit: z.string().trim().max(3).toUpperCase(),
  discount: scaledNumber(2),
  price: scaledNumber(5),
  branch: z.number().int().min(-2147483648).max(2147483647),
  pieces: z.string().max(1000),
}).strict();
const revisionSchema = z.object({
  revision: z.number().int().min(0).max(2147483647),
  legacyVersion: z.string().regex(/^[0-9a-f]{64}$/),
});
const removalSchema = revisionSchema.extend({ number: numberParamsSchema.shape.purchaseOrderNumber }).strict();
const confirmationSchema = revisionSchema.extend({ mode: z.enum(['confirm', 'unconfirm']) }).strict();
const editSchema = revisionSchema.extend({
  removeZero: z.boolean(),
  lines: z.array(lineSchema),
}).strict();
const productQuery = z.object({ q: z.string().trim().min(1).max(60) });
const supplierCode = z.string().trim().min(1).max(20).toUpperCase();
const createDate = dateSchema.refine((date) => {
  const parsed = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(date);
}, 'Fecha inválida.');
const percentage = scaledNumber(2).refine((value) => value >= 0 && value <= 100, 'El porcentaje debe estar entre 0 y 100.');
const charge = scaledNumber(2).refine((value) => value >= 0, 'El importe debe ser mayor o igual a cero.');
const createSchema = z.object({
  requestKey: z.string().uuid().toLowerCase(),
  supplierCode,
  supplierOrderNumber: z.string().trim().max(30).toUpperCase(),
  orderedAt: createDate, from: createDate, dueAt: createDate,
  warehouse: z.string().trim().min(1).max(10).toUpperCase(),
  agent: z.string().trim().max(9).toUpperCase(),
  discountPercentages: z.tuple([percentage, percentage, percentage]),
  taxPercentage: percentage,
  freight: charge, insurance: charge, other: charge,
  onAccount: charge,
  otherLabel: z.string().trim().max(40),
  lines: z.array(lineSchema.extend({
    id: z.null(),
    quantity: scaledNumber(3).refine((value) => value >= 0, 'La cantidad debe ser mayor o igual a cero.'),
    discount: percentage,
    price: scaledNumber(5).refine((value) => value >= 0, 'El precio debe ser mayor o igual a cero.'),
  })).min(1),
}).strict();
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
    private readonly updateClassifications: UpdatePurchaseOrderClassifications,
    private readonly editOrder: EditPurchaseOrder,
    private readonly createOrder: CreatePurchaseOrder,
    private readonly removeOrder: RemovePurchaseOrder,
    private readonly confirmOrder: ConfirmPurchaseOrder,
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

  classify: RequestHandler = async (request, response, next) => {
    try {
      const { purchaseOrderId } = idParamsSchema.parse(request.params);
      response.json(await this.updateClassifications.execute(purchaseOrderId, classificationSchema.parse(request.body)));
    } catch (error) { next(error); }
  };

  getEditor: RequestHandler = async (request, response, next) => {
    try {
      const { purchaseOrderId } = idParamsSchema.parse(request.params);
      response.json({ data: await this.editOrder.get(purchaseOrderId) });
    } catch (error) { next(error); }
  };

  searchEditorProducts: RequestHandler = async (request, response, next) => {
    try {
      const { purchaseOrderId } = idParamsSchema.parse(request.params);
      const { q } = productQuery.parse(request.query);
      response.json({ data: await this.editOrder.products(purchaseOrderId, q) });
    } catch (error) { next(error); }
  };

  saveEdition: RequestHandler = async (request, response, next) => {
    try {
      const { purchaseOrderId } = idParamsSchema.parse(request.params);
      response.json({ data: await this.editOrder.save(purchaseOrderId, editSchema.parse(request.body)) });
    } catch (error) { next(error); }
  };

  getCreation: RequestHandler = async (_request, response, next) => {
    try { response.json({ data: await this.createOrder.get() }); } catch (error) { next(error); }
  };

  searchCreationSuppliers: RequestHandler = async (request, response, next) => {
    try {
      const { q } = productQuery.parse(request.query);
      response.json({ data: await this.createOrder.suppliers(q) });
    } catch (error) { next(error); }
  };

  searchCreationProducts: RequestHandler = async (request, response, next) => {
    try {
      const { q, supplierCode: code } = productQuery.extend({ supplierCode }).parse(request.query);
      response.json({ data: await this.createOrder.products(code, q) });
    } catch (error) { next(error); }
  };

  create: RequestHandler = async (request, response, next) => {
    try { response.status(201).json({ data: await this.createOrder.save(createSchema.parse(request.body)) }); }
    catch (error) { next(error); }
  };

  getRemoval: RequestHandler = async (request, response, next) => {
    try {
      const { purchaseOrderId } = idParamsSchema.parse(request.params);
      response.json({ data: await this.removeOrder.get(purchaseOrderId) });
    } catch (error) { next(error); }
  };

  remove: RequestHandler = async (request, response, next) => {
    try {
      const { purchaseOrderId } = idParamsSchema.parse(request.params);
      response.json({ data: await this.removeOrder.execute(purchaseOrderId, removalSchema.parse(request.body)) });
    } catch (error) { next(error); }
  };

  getConfirmation: RequestHandler = async (request, response, next) => {
    try {
      const { purchaseOrderId } = idParamsSchema.parse(request.params);
      response.json({ data: await this.confirmOrder.get(purchaseOrderId) });
    } catch (error) { next(error); }
  };

  confirm: RequestHandler = async (request, response, next) => {
    try {
      const { purchaseOrderId } = idParamsSchema.parse(request.params);
      response.json({ data: await this.confirmOrder.execute(purchaseOrderId, confirmationSchema.parse(request.body)) });
    } catch (error) { next(error); }
  };
}
