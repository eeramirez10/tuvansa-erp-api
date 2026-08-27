import type { RequestHandler } from 'express';
import { z } from 'zod';
import type { CreateOrder } from '../../application/use-cases/create-order.js';
import type { DeleteOrder } from '../../application/use-cases/delete-order.js';
import type { GetOrder } from '../../application/use-cases/get-order.js';
import type { GetOrderPanel } from '../../application/use-cases/get-order-panel.js';
import type { NavigateOrder } from '../../application/use-cases/navigate-order.js';
import type { SearchOrders } from '../../application/use-cases/search-orders.js';
import type { UpdateOrder } from '../../application/use-cases/update-order.js';
import type { OrderPanelKey } from '../../domain/repositories/order-panels-repository.js';
import type { OrderCreateValues, OrderUpdateValues } from '../../domain/repositories/orders-repository.js';

const orderParamsSchema = z.object({ orderId: z.coerce.number().int().positive() });
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const searchSchema = z.object({
  q: z.string().trim().min(1).optional(),
  status: z.string().trim().min(1).optional(),
  customerCode: z.string().trim().min(1).optional(),
  from: dateSchema.optional(), to: dateSchema.optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(25),
});
const lineSchema = z.object({
  productId: z.number().int().positive(), quantity: z.number().positive(),
  price: z.number().nonnegative(), discount: z.number().min(0).max(100).optional(),
}).strict();
const editableFields = {
  customerId: z.number().int().positive().optional(),
  customerOrderNumber: z.string().trim().max(30).optional(),
  orderedAt: dateSchema.optional(), from: dateSchema.optional(), dueAt: dateSchema.optional(),
  branch: z.number().int().nonnegative().optional(), department: z.string().trim().max(20).optional(),
  attentionCode: z.string().trim().max(10).optional(), termsDays: z.number().int().nonnegative().optional(),
  warehouse: z.string().trim().max(5).optional(), currencyId: z.number().int().nonnegative().optional(),
  initial: z.boolean().optional(), observations: z.string().max(65_535).optional(),
  status: z.string().trim().max(10).optional(), classifications: z.array(z.string().max(10)).max(7).optional(),
  lines: z.array(lineSchema).min(1).optional(),
};
const createSchema = z.object(editableFields).strict().extend({
  number: z.string().trim().min(1).max(15), customerId: z.number().int().positive(),
  orderedAt: dateSchema, lines: z.array(lineSchema).min(1),
}).omit({ status: true, classifications: true });
const updateSchema = z.object(editableFields).strict().refine((value) => Object.keys(value).length > 0, {
  message: 'Debe proporcionar al menos un campo para modificar',
});

export class OrdersController {
  constructor(
    private readonly getOrder: GetOrder,
    private readonly searchOrders: SearchOrders,
    private readonly navigateOrder: NavigateOrder,
    private readonly createOrder: CreateOrder,
    private readonly updateOrder: UpdateOrder,
    private readonly deleteOrder: DeleteOrder,
    private readonly getOrderPanel: GetOrderPanel,
  ) {}

  search: RequestHandler = async (request, response, next) => {
    try {
      const query = searchSchema.parse(request.query);
      response.json(await this.searchOrders.execute({
        ...(query.q === undefined ? {} : { query: query.q }),
        ...(query.status === undefined ? {} : { status: query.status }),
        ...(query.customerCode === undefined ? {} : { customerCode: query.customerCode }),
        ...(query.from === undefined ? {} : { from: query.from }),
        ...(query.to === undefined ? {} : { to: query.to }),
        page: query.page, pageSize: query.pageSize,
      }));
    } catch (error) { next(error); }
  };

  getById: RequestHandler = async (request, response, next) => {
    try {
      const { orderId } = orderParamsSchema.parse(request.params);
      response.json({ data: await this.getOrder.execute(orderId) });
    } catch (error) { next(error); }
  };

  getPrevious: RequestHandler = async (request, response, next) => {
    try {
      const { orderId } = orderParamsSchema.parse(request.params);
      response.json({ data: await this.navigateOrder.execute(orderId, 'previous') });
    } catch (error) { next(error); }
  };

  getNext: RequestHandler = async (request, response, next) => {
    try {
      const { orderId } = orderParamsSchema.parse(request.params);
      response.json({ data: await this.navigateOrder.execute(orderId, 'next') });
    } catch (error) { next(error); }
  };

  create: RequestHandler = async (request, response, next) => {
    try {
      const input = createSchema.parse(request.body) as OrderCreateValues;
      response.status(201).json({ data: await this.createOrder.execute(input) });
    }
    catch (error) { next(error); }
  };

  update: RequestHandler = async (request, response, next) => {
    try {
      const { orderId } = orderParamsSchema.parse(request.params);
      const input = updateSchema.parse(request.body) as OrderUpdateValues;
      response.json({ data: await this.updateOrder.execute(orderId, input) });
    } catch (error) { next(error); }
  };

  delete: RequestHandler = async (request, response, next) => {
    try {
      const { orderId } = orderParamsSchema.parse(request.params);
      await this.deleteOrder.execute(orderId); response.status(204).send();
    } catch (error) { next(error); }
  };

  panel = (key: OrderPanelKey): RequestHandler => async (request, response, next) => {
    try {
      const { orderId } = orderParamsSchema.parse(request.params);
      response.json(await this.getOrderPanel.execute(orderId, key));
    } catch (error) { next(error); }
  };
}
