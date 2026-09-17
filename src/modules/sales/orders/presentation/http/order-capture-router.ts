import { Router } from 'express';
import { z } from 'zod';
import type { CaptureOrder } from '../../application/use-cases/capture-order.js';

const code = z.string().trim().min(1).max(13);
const date = z.iso.date();
export const captureInputSchema = z.object({
  warehouse: z.string().trim().min(1).max(6), typeCode: z.literal('P'),
  customerCode: z.string().trim().min(1).max(6), customerOrderNumber: z.string().trim().max(30).default(''),
  orderedAt: date, from: date, dueAt: date, department: z.string().trim().max(20).default(''),
  initial: z.boolean().default(false), agentCode: z.string().trim().min(1).max(5),
  termsDays: z.number().int().min(0).max(999), store: z.string().trim().max(4),
  observations: z.string().max(21).default(''), documentKind: z.enum(['order', 'quote']).default('quote'),
  lines: z.array(z.object({
    productCode: code, quantity: z.number().positive().max(999999).multipleOf(0.001),
    price: z.number().nonnegative().max(999999999).multipleOf(0.00001),
    discount: z.number().min(0).max(100).multipleOf(0.01).default(0),
  }).strict()).min(1).max(500),
}).strict().refine(v => v.from <= v.dueAt, { message: 'Desde no puede ser posterior a Vence', path: ['dueAt'] });

export const createOrderCaptureRouter = (useCase: CaptureOrder): Router => {
  const router = Router();
  router.get('/capture/options', async (_req, res, next) => {
    try { res.json({ data: await useCase.options() }); } catch (error) { next(error); }
  });
  router.get('/capture/customers/:code', async (req, res, next) => {
    try { res.json({ data: await useCase.customer(z.string().trim().min(1).max(6).parse(req.params.code)) }); } catch (error) { next(error); }
  });
  router.get('/capture/products/:code', async (req, res, next) => {
    try {
      const query = z.object({ warehouse: z.string().trim().min(1).max(6), typeCode: z.literal('P'), customerCode: z.string().trim().min(1).max(6) }).parse(req.query);
      res.json({ data: await useCase.product(code.parse(req.params.code), query.warehouse, query.typeCode, query.customerCode) });
    } catch (error) { next(error); }
  });
  router.post('/capture', async (req, res, next) => {
    try { res.status(201).json({ data: await useCase.create(captureInputSchema.parse(req.body)) }); } catch (error) { next(error); }
  });
  router.post('/:orderId/actions/quote-conversion', async (req, res, next) => {
    try {
      z.object({}).strict().parse(req.body ?? {});
      res.json({ data: await useCase.convertQuote(z.coerce.number().int().positive().parse(req.params.orderId)) });
    } catch (error) { next(error); }
  });
  return router;
};
