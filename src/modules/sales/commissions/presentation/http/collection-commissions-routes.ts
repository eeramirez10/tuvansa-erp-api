import { Router } from 'express';
import { z } from 'zod';
import type { GetCollectionCommissions } from '../../application/use-cases/get-collection-commissions.js';
const criteria = z.object({ from: z.iso.date(), to: z.iso.date(), branch: z.string().regex(/^(all|0[1-7])$/).default('01'),
  agent: z.string().max(20).default('all') }).strict();
export function createCollectionCommissionsRouter(report: GetCollectionCommissions): Router {
  const router = Router();
  router.get('/collection-commissions/options', async (_req, res, next) => {
    try { res.set('Cache-Control', 'no-store').json({ data: await report.options() }); } catch (error) { next(error); }
  });
  router.get('/collection-commissions', async (req, res, next) => {
    try { res.set('Cache-Control', 'no-store').json({ data: await report.execute(criteria.parse(req.query)) }); } catch (error) { next(error); }
  });
  return router;
}
