import { Router } from 'express';
import { z } from 'zod';
import type { DuplicatePolicyLiability } from '../../application/use-cases/duplicate-policy-liability.js';
import { policyCents } from '../../application/use-cases/manage-manual-policy.js';
import { requireSessionOrigin, sessionToken } from '../../../../general-data/users/presentation/web-session-http.js';

const id = z.coerce.number().int().positive();
const amount = z.number().positive().max(999_999_999.99).refine(value => policyCents(value) !== null);
const draft = z.strictObject({
  date: z.iso.date(),
  supplierCode: z.string().trim().min(1).max(12).refine(value => !value.includes('\0')),
  reference: z.string().trim().min(1).max(20).refine(value => !value.includes('\0')),
  amount,
});
const preview = draft.extend({ amount: z.string().regex(/^\d+(?:\.\d{1,2})?$/).transform(Number).pipe(amount) });
const confirmation = draft.extend({
  revision: z.string().regex(/^[a-f0-9]{64}$/), requestKey: z.uuid(), confirmed: z.literal(true),
});
const path = '/:policyId/actions/duplicate-liability';

export function createPolicyLiabilityRouter(
  action: DuplicatePolicyLiability,
  authorize: (token?: string) => Promise<{ id: string; legacyId: number }>,
): Router {
  const router = Router();
  router.get(path, async (request, response) => {
    await authorize(sessionToken(request));
    response.set('Cache-Control', 'no-store').json({ data: await action.prepare(id.parse(request.params.policyId)) });
  });
  router.get(`${path}/preview`, async (request, response) => {
    await authorize(sessionToken(request));
    response.set('Cache-Control', 'no-store').json({ data: await action.preview(id.parse(request.params.policyId), preview.parse(request.query)) });
  });
  router.post(path, async (request, response) => {
    requireSessionOrigin(request);
    const actor = await authorize(sessionToken(request));
    const { revision, requestKey, date, supplierCode, amount, reference } = confirmation.parse(request.body);
    response.status(201).json({ data: await action.confirm(id.parse(request.params.policyId),
      { date, supplierCode, amount, reference }, revision, requestKey.toLowerCase(), actor) });
  });
  return router;
}
