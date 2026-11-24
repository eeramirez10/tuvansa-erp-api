import type { RequestHandler } from 'express';
import { z } from 'zod';
import type { CancelPurchaseReception } from '../../application/use-cases/cancel-purchase-reception.js';
import type { ReversePurchasePosting } from '../../application/use-cases/reverse-purchase-posting.js';
import type { PostingReversalTarget } from '../../domain/datasources/purchase-posting-reversal-data-source.js';

const id = z.coerce.number().int().positive();
const paymentParams = z.object({ supplierId: id, paymentId: id });
const expenseParams = z.object({ purchaseReceptionId: id });
const capture = z.strictObject({
  requestKey: z.uuid(), date: z.iso.date(), reason: z.string().trim().min(1).max(90), confirmed: z.literal(true),
});
const paymentCapture = capture.extend({ expectedReconciliationId: z.int().positive().nullable().optional() });

export function postingReversalHandlers(service: ReversePurchasePosting, kind: PostingReversalTarget['kind']) {
  const actor = { companyId: 1, userId: 0 };
  const target = (params: unknown): PostingReversalTarget => kind === 'payment'
    ? { kind, ...paymentParams.parse(params) } : { kind, documentId: expenseParams.parse(params).purchaseReceptionId };

  const prepare: RequestHandler = async (request, response, next) => {
    try { response.json({ data: await service.prepare(actor.companyId, target(request.params)) }); }
    catch (error) { next(error); }
  };
  const save: RequestHandler = async (request, response, next) => {
    try {
      const input = (kind === 'payment' ? paymentCapture : capture).parse(request.body);
      const data = await service.save(actor, target(request.params), input);
      response.status(201).json({ data });
    } catch (error) { next(error); }
  };
  return { prepare, save };
}

export function purchaseReceptionCancellationHandlers(service: CancelPurchaseReception) {
  const actor = { companyId: 1, userId: 0 };
  const prepare: RequestHandler = async (request, response, next) => {
    try {
      const { purchaseReceptionId } = expenseParams.parse(request.params);
      response.json({ data: await service.prepare(actor.companyId, purchaseReceptionId) });
    } catch (error) { next(error); }
  };
  const save: RequestHandler = async (request, response, next) => {
    try {
      const { purchaseReceptionId } = expenseParams.parse(request.params);
      const data = await service.save(actor, purchaseReceptionId, capture.parse(request.body));
      response.status(201).json({ data });
    } catch (error) { next(error); }
  };
  return { prepare, save };
}
