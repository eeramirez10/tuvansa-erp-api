import type { RequestHandler } from 'express';
import { z } from 'zod';
import type { ManagePurchaseReceptionDocumentation } from '../../application/use-cases/manage-purchase-reception-documentation.js';

const actor = { companyId: 1, userId: 0 };
const params = z.object({ purchaseReceptionId: z.coerce.number().int().positive() });
const input = z.strictObject({
  requestKey: z.uuid(),
  revision: z.string().regex(/^[0-9a-f]{64}$/),
  documents: z.array(z.strictObject({ number: z.string().trim().min(1).max(13), amount: z.number().positive() })).min(1).max(4),
});

export class PurchaseReceptionDocumentationController {
  constructor(private readonly documentation: ManagePurchaseReceptionDocumentation) {}

  preview: RequestHandler = async (request, response, next) => {
    try {
      const { purchaseReceptionId } = params.parse(request.params);
      const data = await this.documentation.preview(actor.companyId, purchaseReceptionId);
      response.set('Cache-Control', 'no-store').json({ data });
    } catch (error) { next(error); }
  };

  save: RequestHandler = async (request, response, next) => {
    try {
      const { purchaseReceptionId } = params.parse(request.params);
      const data = await this.documentation.save(actor, purchaseReceptionId, input.parse(request.body));
      response.status(201).json({ data });
    } catch (error) { next(error); }
  };
}
