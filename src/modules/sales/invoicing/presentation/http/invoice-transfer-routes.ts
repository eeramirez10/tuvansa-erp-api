import { Router } from 'express';
import { z } from 'zod';
import { requireSessionOrigin, sessionToken } from '../../../../general-data/users/presentation/web-session-http.js';
import type { InvoiceTransferActor, PostgresInvoiceTransfers } from '../../infrastructure/datasources/postgres-invoice-transfers.js';

const id = z.coerce.number().int().positive();
const warehouse = z.string().regex(/^[A-Z0-9]{1,6}$/);
const criteria = z.strictObject({ warehouse: warehouse.optional() });
const confirmation = z.strictObject({
  warehouse, revision: z.string().regex(/^[a-f0-9]{64}$/), requestKey: z.uuid(), confirmed: z.literal(true),
});
const path = '/:invoiceId/summaries/transfer';

export function createInvoiceTransferRouter(
  action: Pick<PostgresInvoiceTransfers, 'preview' | 'confirm'>,
  authorize: (token?: string) => Promise<InvoiceTransferActor>,
): Router {
  const router = Router();
  router.get(`${path}/preview`, async (request, response) => {
    const actor = await authorize(sessionToken(request));
    const query = criteria.parse(request.query);
    const data = await action.preview(id.parse(request.params.invoiceId), actor, query.warehouse ?? null);
    response.set('Cache-Control', 'no-store').json({ data });
  });
  router.post(path, async (request, response) => {
    requireSessionOrigin(request);
    const actor = await authorize(sessionToken(request));
    const input = confirmation.parse(request.body);
    const data = await action.confirm(id.parse(request.params.invoiceId), actor, { ...input, requestKey: input.requestKey.toLowerCase() });
    response.status(201).json({ data });
  });
  return router;
}
