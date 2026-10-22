import { Router } from 'express';
import { z } from 'zod';
import type { GetIncomeStatement } from '../../application/use-cases/get-income-statement.js';

const criteria=z.object({
  accounts:z.literal('8').default('8'),
  month:z.coerce.number().int().min(1).max(24),
  level:z.coerce.number().int().min(1).max(8).default(3),
}).strict();

export const createIncomeStatementRouter = (report: GetIncomeStatement): Router => {
  const router=Router();
  router.get('/income-statement/options',async (_req,res,next)=>{
    try { res.set('Cache-Control','no-store').json({data:await report.options()}); } catch(error) { next(error); }
  });
  router.get('/income-statement',async (req,res,next)=>{
    try { res.set('Cache-Control','no-store').json({data:await report.execute(criteria.parse(req.query))}); } catch(error) { next(error); }
  });
  return router;
};
