import { Router } from 'express';
import { z } from 'zod';
import type { GetMexicoIncomeStatement } from '../../application/use-cases/get-mexico-income-statement.js';
import type { GetIncomeStatement } from '../../application/use-cases/get-income-statement.js';

const criteria=z.object({
  accounts:z.literal('8').default('8'),
  month:z.coerce.number().int().min(1).max(24),
  level:z.coerce.number().int().min(1).max(8).default(3),
}).strict();

export const createIncomeStatementRouter = (report: GetIncomeStatement, mexico?: GetMexicoIncomeStatement): Router => {
  const router=Router();
  if (mexico) {
    const mexicoCriteria=z.object({month:z.coerce.number().int().min(1).max(12),year:z.coerce.number().int().min(2000).max(2100)}).strict();
    router.get('/income-statement/mexico/options',async (_req,res,next)=>{
      try { res.set('Cache-Control','no-store').json({data:await mexico.options()}); } catch(error) { next(error); }
    });
    router.get('/income-statement/mexico',async (req,res,next)=>{
      try { res.set('Cache-Control','no-store').json({data:await mexico.execute(mexicoCriteria.parse(req.query))}); } catch(error) { next(error); }
    });
  }
  router.get('/income-statement/options',async (_req,res,next)=>{
    try { res.set('Cache-Control','no-store').json({data:await report.options()}); } catch(error) { next(error); }
  });
  router.get('/income-statement',async (req,res,next)=>{
    try { res.set('Cache-Control','no-store').json({data:await report.execute(criteria.parse(req.query))}); } catch(error) { next(error); }
  });
  return router;
};
