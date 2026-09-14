import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import type { ClientFiscalUseCases } from '../../application/use-cases/client-fiscal.js';

const params = z.object({ clientId: z.coerce.number().int().positive() });
export const fiscalSaveSchema = z.object({
  expectedVersion: z.string().regex(/^[a-f0-9]{64}$/),
  values: z.object({
    taxId: z.string().trim().min(1).max(15),
    name: z.string().trim().min(1).max(255),
    postalCode: z.string().trim().min(1).max(12),
    fiscalRegime: z.string().trim().regex(/^\d{3}$/, 'Capture un régimen de tres dígitos'),
  }).strict(),
}).strict();

export class ClientFiscalController {
  constructor(private readonly useCases: ClientFiscalUseCases) {}
  get: RequestHandler = async (req, res, next) => {
    try { res.json(await this.useCases.get(params.parse(req.params).clientId)); }
    catch (error) { next(error); }
  };
  save: RequestHandler = async (req, res, next) => {
    try { res.json(await this.useCases.save(params.parse(req.params).clientId, fiscalSaveSchema.parse(req.body))); }
    catch (error) { next(error); }
  };
  verify: RequestHandler = async (req, res, next) => {
    try { z.object({}).strict().parse(req.body ?? {}); res.json(await this.useCases.verify(params.parse(req.params).clientId)); }
    catch (error) { next(error); }
  };
}

export const createClientFiscalRouter = (controller: ClientFiscalController): Router => {
  const router = Router({ mergeParams: true });
  router.get('/', controller.get);
  router.patch('/', controller.save);
  router.post('/verify', controller.verify);
  return router;
};
