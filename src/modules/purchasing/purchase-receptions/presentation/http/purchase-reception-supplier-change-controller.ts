import type { RequestHandler } from 'express';
import { z } from 'zod';
import type { ChangePurchaseReceptionSupplier } from '../../application/use-cases/change-purchase-reception-supplier.js';

const companyId = 1;
const params = z.object({ purchaseReceptionId: z.coerce.number().int().positive() });
const code = (max: number) => z.string().trim().min(1).max(max).toUpperCase().refine((value) => !value.includes('\0'));
const filters = z.object({ code: code(6).optional(), name: z.string().trim().min(1).max(60).optional() });
const payload = z.strictObject({ supplierCode: code(6), revision: z.string().regex(/^[0-9a-f]{64}$/) });

export class PurchaseReceptionSupplierChangeController {
  constructor(private readonly change: ChangePurchaseReceptionSupplier) {}

  preview: RequestHandler = async (request, response, next) => {
    try {
      const { purchaseReceptionId } = params.parse(request.params);
      response.set('Cache-Control', 'no-store').json({ data: await this.change.preview(companyId, purchaseReceptionId) });
    } catch (error) { next(error); }
  };

  suppliers: RequestHandler = async (request, response, next) => {
    try {
      const { purchaseReceptionId } = params.parse(request.params);
      const { code, name } = filters.parse(request.query);
      response.json({ data: await this.change.search(companyId, purchaseReceptionId, {
        ...(code ? { code } : {}), ...(name ? { name } : {}),
      }) });
    } catch (error) { next(error); }
  };

  save: RequestHandler = async (request, response, next) => {
    try {
      const { purchaseReceptionId } = params.parse(request.params);
      response.json({ data: await this.change.save(companyId, purchaseReceptionId, payload.parse(request.body)) });
    } catch (error) { next(error); }
  };
}
