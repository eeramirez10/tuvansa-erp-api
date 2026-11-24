import type { RequestHandler } from 'express';
import { z } from 'zod';
import type { UpdatePurchaseReceptionClassifications } from '../../application/use-cases/update-purchase-reception-classifications.js';

const params = z.object({ purchaseReceptionId: z.coerce.number().int().positive() });
const input = z.strictObject({
  current: z.array(z.string().max(16).refine((code) => !code.includes('\0'))).length(9),
  revision: z.string().regex(/^[0-9a-f]{64}$/),
});

export class PurchaseReceptionClassificationsController {
  constructor(private readonly update: UpdatePurchaseReceptionClassifications) {}

  save: RequestHandler = async (request, response, next) => {
    try {
      const { purchaseReceptionId } = params.parse(request.params);
      response.json({ data: await this.update.execute(purchaseReceptionId, input.parse(request.body)) });
    } catch (error) { next(error); }
  };
}
