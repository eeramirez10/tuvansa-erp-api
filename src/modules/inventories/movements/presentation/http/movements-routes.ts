import { Router } from 'express';
import { z } from 'zod';
import type { ReadInventoryMovements } from '../../application/use-cases/read-inventory-movements.js';

const textFilter = z.string().trim().min(1).max(64).optional();
const searchSchema = z.object({
  document: textFilter,
  date: z.iso.date().optional(),
  reference: textFilter,
  reference2: textFilter,
  warehouse: textFilter,
  supplier: textFilter,
  customer: textFilter,
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(25),
}).refine(({ page, pageSize }) => Number.isSafeInteger((page - 1) * pageSize));

const idParamsSchema = z.object({ id: z.coerce.number().int().positive() });

export const createMovementsRouter = (movements: ReadInventoryMovements): Router => {
  const router = Router();
  router.get('/', async (request, response) => {
    response.json(await movements.search(searchSchema.parse(request.query)));
  });
  router.get('/:id', async (request, response) => {
    const { id } = idParamsSchema.parse(request.params);
    response.json(await movements.getById(id));
  });
  return router;
};
