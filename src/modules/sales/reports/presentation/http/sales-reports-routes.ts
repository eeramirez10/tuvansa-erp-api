import { Router } from 'express';
import { z } from 'zod';
import type { GetSalesByFamily } from '../../application/use-cases/get-sales-by-family.js';
const criteria = z.object({ from: z.iso.date(), to: z.iso.date(), branch: z.string().regex(/^(all|0[1-7])$/).default('01'), family: z.string().max(4).default('all') }).strict();
export function createSalesReportsRouter(report: GetSalesByFamily): Router {
  const router = Router();
  router.get('/by-family/options', async (_req, res, next) => { try { res.set('Cache-Control', 'no-store').json({ data: await report.options() }); } catch (error) { next(error); } });
  router.get('/by-family', async (req, res, next) => { try { res.set('Cache-Control', 'no-store').json({ data: await report.execute(criteria.parse(req.query)) }); } catch (error) { next(error); } });
  return router;
}
