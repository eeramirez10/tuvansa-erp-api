import { Router } from 'express';
import { z } from 'zod';
import type { GetCollectionCommissions } from '../../application/use-cases/get-collection-commissions.js';
const criteria = z.object({ from: z.iso.date(), to: z.iso.date(), branch: z.string().regex(/^(all|0[1-7])$/).default('01'),
  agent: z.string().max(20).default('all') }).strict();
const money = z.number().finite().min(0).max(1_000_000_000_000).multipleOf(0.01);
const settings = z.object({ bonusMode: z.enum(['additional','exclusive','unconfirmed']), agents: z.array(z.object({
  code: z.string().max(20), plan: z.enum(['salary','fixed','unconfirmed']).optional(), fixedRate: z.number().min(0).max(100).multipleOf(0.01).optional(),
  costBasis: z.enum(['proportional','total']).optional(), costOverride: money.nullable().optional(), freight: money.optional(), gratuities: money.optional(), includeLm: z.boolean().optional(),
}).strict().refine(a => a.plan !== 'fixed' || a.fixedRate !== undefined, { message: 'Indica el porcentaje fijo.' })).max(150)
  .refine(rows => new Set(rows.map(r => r.code)).size === rows.length, { message: 'No repitas agentes.' }) }).strict();
export function createCollectionCommissionsRouter(report: GetCollectionCommissions): Router {
  const router = Router();
  router.get('/collection-commissions/options', async (_req, res, next) => {
    try { res.set('Cache-Control', 'no-store').json({ data: await report.options() }); } catch (error) { next(error); }
  });
  router.get('/collection-commissions', async (req, res, next) => {
    try { res.set('Cache-Control', 'no-store').json({ data: await report.execute(criteria.parse(req.query)) }); } catch (error) { next(error); }
  });
  // Recalculation only: same READ ONLY source, no persistence or ERP updates.
  router.post('/collection-commissions/preview', async (req, res, next) => {
    try { const body = z.object({ criteria, settings }).strict().parse(req.body);
      res.set('Cache-Control', 'no-store').json({ data: await report.execute(body.criteria, body.settings) }); } catch (error) { next(error); }
  });
  return router;
}
