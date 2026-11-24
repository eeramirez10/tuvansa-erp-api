import { Router } from 'express';
import { z } from 'zod';
import { policyCents, type ManageManualPolicy } from '../../application/use-cases/manage-manual-policy.js';

const params = z.object({ policyId: z.coerce.number().int().positive() });
const amount = z.number().refine((value) => policyCents(value) !== null, 'Usa importes no negativos con hasta dos decimales.');
const action = z.strictObject({ requestKey: z.uuid(), revision: z.int().positive(), confirmed: z.literal(true) });
const policy = z.strictObject({
  requestKey: z.uuid(), date: z.iso.date(), concept: z.string().trim().max(90), beneficiary: z.string().trim().max(85),
  family: z.string().trim().max(20), lines: z.array(z.strictObject({
    accountCode: z.string().trim().min(1).max(16), costCenter: z.int().nonnegative(), debit: amount, credit: amount,
    reference: z.string().trim().max(45),
  })).min(2).max(100),
});
const change = policy.extend({ revision: z.int().positive() });

export function createManualPolicyRouter(manual: ManageManualPolicy): Router {
  const router = Router();
  router.get('/capture', async (_request, response) => {
    response.set('Cache-Control', 'no-store').json({ data: await manual.prepare() });
  });
  router.get('/capture/accounts', async (request, response) => {
    const query = z.string().trim().max(100).default('').parse(request.query.q);
    response.json({ data: await manual.accounts(query) });
  });
  router.post('/', async (request, response) => {
    const data = await manual.create(policy.parse(request.body));
    response.status(201).json({ data });
  });
  router.get('/:policyId/actions/manual', async (request, response) => {
    const { policyId } = params.parse(request.params);
    response.set('Cache-Control', 'no-store').json({ data: await manual.preview(policyId) });
  });
  router.patch('/:policyId', async (request, response) => {
    const { policyId } = params.parse(request.params);
    response.json({ data: await manual.change(policyId, change.parse(request.body)) });
  });
  for (const operation of ['apply', 'unapply'] as const) {
    router.post(`/:policyId/actions/${operation}`, async (request, response) => {
      const { policyId } = params.parse(request.params);
      response.json({ data: await manual.perform(policyId, operation, action.parse(request.body)) });
    });
  }
  router.delete('/:policyId', async (request, response) => {
    const { policyId } = params.parse(request.params);
    response.json({ data: await manual.perform(policyId, 'cancel', action.parse(request.body)) });
  });
  return router;
}
