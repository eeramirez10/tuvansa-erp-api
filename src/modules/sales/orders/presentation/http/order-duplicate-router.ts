import { Router } from 'express';
import { z } from 'zod';
import { getCompanyContext } from '../../../../companies/application/company-catalog.js';
import type { OrderDuplicateDataSource } from '../../domain/datasources/order-duplicate-data-source.js';
import { toOrderResponse } from '../../application/dtos/order-response.js';

export function createOrderDuplicateRouter(source: OrderDuplicateDataSource): Router {
  const router = Router();
  const path = '/:orderId/actions/duplicate';
  const id = z.coerce.number().int().positive();
  const query = z.object({ companyId: z.coerce.number().int().positive().default(1) });
  const confirmation = z.strictObject({
    requestKey: z.uuid().transform(value => value.toLowerCase()),
    revision: z.string().regex(/^[a-f0-9]{64}$/), orderedAt: z.iso.date(),
  });
  const companyId = (value: unknown) => getCompanyContext(query.parse(value).companyId).company.id;
  router.get(path, async (req, res) => {
    res.json({ data: await source.previewDuplicate(id.parse(req.params.orderId), companyId(req.query)) });
  });
  router.post(path, async (req, res) => {
    const order = await source.duplicate(id.parse(req.params.orderId), companyId(req.query), confirmation.parse(req.body));
    res.status(201).json({ data: toOrderResponse(order) });
  });
  return router;
}
