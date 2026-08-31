import type { RequestHandler } from 'express';
import { z } from 'zod';
import type { GetPurchaseReceptionByNumber } from '../../application/use-cases/get-purchase-reception-by-number.js';
import type { GetPurchaseReceptionPanel } from '../../application/use-cases/get-purchase-reception-panel.js';
import type { GetPurchaseReception } from '../../application/use-cases/get-purchase-reception.js';
import type { NavigatePurchaseReception } from '../../application/use-cases/navigate-purchase-reception.js';
import type { SearchPurchaseReceptions } from '../../application/use-cases/search-purchase-receptions.js';
import type { PurchaseReceptionPanelKey } from '../../domain/repositories/purchase-receptions-repository.js';

const idParamsSchema = z.object({ purchaseReceptionId: z.coerce.number().int().positive() });
const numberParamsSchema = z.object({ purchaseReceptionNumber: z.string().trim().min(1).max(15) });
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const searchSchema = z.object({
  q: z.string().trim().min(1).optional(),
  documentNumber: z.string().trim().min(1).max(15).optional(),
  receivedAt: dateSchema.optional(),
  orderNumber: z.string().trim().min(1).max(15).optional(),
  supplierReference: z.string().trim().min(1).max(30).optional(),
  deliveryNote: z.string().trim().min(1).max(30).optional(),
  folio: z.string().trim().min(1).max(30).optional(),
  supplierCode: z.string().trim().min(1).max(20).optional(),
  warehouse: z.string().trim().min(1).max(10).optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(25),
});

export class PurchaseReceptionsController {
  constructor(
    private readonly getReception: GetPurchaseReception,
    private readonly getByNumber: GetPurchaseReceptionByNumber,
    private readonly searchReceptions: SearchPurchaseReceptions,
    private readonly navigateReception: NavigatePurchaseReception,
    private readonly getPanel: GetPurchaseReceptionPanel,
  ) {}

  search: RequestHandler = async (request, response, next) => {
    try {
      const query = searchSchema.parse(request.query);
      response.json(await this.searchReceptions.execute({
        ...(query.q === undefined ? {} : { query: query.q }),
        ...(query.documentNumber === undefined ? {} : { documentNumber: query.documentNumber }),
        ...(query.receivedAt === undefined ? {} : { receivedAt: query.receivedAt }),
        ...(query.orderNumber === undefined ? {} : { orderNumber: query.orderNumber }),
        ...(query.supplierReference === undefined ? {} : { supplierReference: query.supplierReference }),
        ...(query.deliveryNote === undefined ? {} : { deliveryNote: query.deliveryNote }),
        ...(query.folio === undefined ? {} : { folio: query.folio }),
        ...(query.supplierCode === undefined ? {} : { supplierCode: query.supplierCode }),
        ...(query.warehouse === undefined ? {} : { warehouse: query.warehouse }),
        page: query.page,
        pageSize: query.pageSize,
      }));
    } catch (error) { next(error); }
  };

  getById: RequestHandler = async (request, response, next) => {
    try {
      const { purchaseReceptionId } = idParamsSchema.parse(request.params);
      response.json({ data: await this.getReception.execute(purchaseReceptionId) });
    } catch (error) { next(error); }
  };

  getByNumberHandler: RequestHandler = async (request, response, next) => {
    try {
      const { purchaseReceptionNumber } = numberParamsSchema.parse(request.params);
      response.json({ data: await this.getByNumber.execute(purchaseReceptionNumber) });
    } catch (error) { next(error); }
  };

  previous: RequestHandler = async (request, response, next) => {
    try {
      const { purchaseReceptionId } = idParamsSchema.parse(request.params);
      response.json({ data: await this.navigateReception.execute(purchaseReceptionId, 'previous') });
    } catch (error) { next(error); }
  };

  next: RequestHandler = async (request, response, next) => {
    try {
      const { purchaseReceptionId } = idParamsSchema.parse(request.params);
      response.json({ data: await this.navigateReception.execute(purchaseReceptionId, 'next') });
    } catch (error) { next(error); }
  };

  panel = (key: PurchaseReceptionPanelKey): RequestHandler => async (request, response, next) => {
    try {
      const { purchaseReceptionId } = idParamsSchema.parse(request.params);
      response.json(await this.getPanel.execute(purchaseReceptionId, key));
    } catch (error) { next(error); }
  };
}
