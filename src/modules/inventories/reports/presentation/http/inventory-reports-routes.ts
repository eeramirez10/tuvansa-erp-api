import { Router } from 'express';
import { z } from 'zod';
import type { GetInventoryByFamily } from '../../application/use-cases/get-inventory-by-family.js';

const criteria = z.object({ asOf: z.iso.date(), warehouse: z.string().regex(/^(all|[A-Za-z0-9]{1,6})$/).default('01'), family: z.string().max(4).default('all') }).strict();
export const createInventoryReportsRouter = (report: GetInventoryByFamily): Router => {
  const router = Router();
  router.get('/by-family/options', async (_req, res, next) => {
    try { res.set('Cache-Control', 'no-store').json({ data: await report.options() }); } catch (error) { next(error); }
  });
  router.get('/by-family', async (req, res, next) => {
    try { res.set('Cache-Control', 'no-store').json({ data: await report.execute(criteria.parse(req.query)) }); } catch (error) { next(error); }
  });
  return router;
};
