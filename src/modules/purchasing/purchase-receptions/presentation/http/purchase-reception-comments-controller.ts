import type { RequestHandler } from 'express';
import { z } from 'zod';
import type { ManagePurchaseReceptionComments } from '../../application/use-cases/manage-purchase-reception-comments.js';

const companyId = 1;
const params = z.object({ purchaseReceptionId: z.coerce.number().int().positive() });
const text = (max: number) => z.string().max(max).refine((value) => !value.includes('\0'), 'El campo contiene caracteres inválidos.');
const date = z.iso.date().nullable();
const folioAt = z.union([
  z.iso.date(),
  z.iso.datetime({ local: true, precision: 0 }).refine((value) => !value.endsWith('Z'), 'Captura la fecha y hora local del folio.'),
]).nullable();
const payload = z.strictObject({
  revision: z.string().regex(/^[0-9a-f]{64}$/),
  fields: z.strictObject({
    dueAt: date, supplierReference: text(30), department: text(13), orderNumber: text(15),
    transportCode: text(4), processDate: date, otherLabel: text(20), boxes: z.int(),
    volume: z.number().min(-9999999999999.99).max(9999999999999.99).multipleOf(0.01),
    folio: text(15), folioAt, lines: z.tuple([text(100), text(100), text(100), text(140), text(3000)]),
    amountInWords: text(350), warehouse: text(10),
  }),
});

export class PurchaseReceptionCommentsController {
  constructor(private readonly comments: ManagePurchaseReceptionComments) {}

  get: RequestHandler = async (request, response, next) => {
    try {
      const { purchaseReceptionId } = params.parse(request.params);
      response.set('Cache-Control', 'no-store').json({ data: await this.comments.get(companyId, purchaseReceptionId) });
    } catch (error) { next(error); }
  };

  save: RequestHandler = async (request, response, next) => {
    try {
      const { purchaseReceptionId } = params.parse(request.params);
      response.json({ data: await this.comments.save(companyId, purchaseReceptionId, payload.parse(request.body)) });
    } catch (error) { next(error); }
  };
}
