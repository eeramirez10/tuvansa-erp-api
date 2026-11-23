import { Router } from 'express';
import { z } from 'zod';
import { getCompanyContext, listCompanies } from '../../application/company-catalog.js';

const companyId = z.string().regex(/^[1-9]\d*$/).transform(Number).pipe(z.int().positive());

export function createCompaniesRouter(): Router {
  const router = Router();

  router.get('/', (_request, response) => {
    response.set('Cache-Control', 'no-store').json({ data: listCompanies() });
  });

  router.get('/:id/context', (request, response) => {
    const id = companyId.parse(request.params.id);
    response.set('Cache-Control', 'no-store').json({ data: getCompanyContext(id) });
  });

  return router;
}
