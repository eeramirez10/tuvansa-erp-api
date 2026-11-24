import { Router } from 'express';
import { z } from 'zod';
import type { CancelInventoryMovement } from '../../application/use-cases/cancel-inventory-movement.js';
import type { CaptureInventoryMovements } from '../../application/use-cases/capture-inventory-movements.js';
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
const adjustmentSchema = z.strictObject({
  requestKey: z.uuid(),
  type: z.enum(['EI', 'SI', 'TR']),
  date: z.iso.date(),
  warehouse: z.string().trim().toUpperCase().min(1).max(10),
  destinationWarehouse: z.string().trim().toUpperCase().min(1).max(10).optional(),
  reference: z.string().trim().max(64).optional(),
  document: z.string().trim().toUpperCase().max(15).regex(/^(EI|SI|TR)[A-Z0-9][A-Z0-9-]*$/).optional(),
  lines: z.array(z.strictObject({
    productId: z.number().int().positive(),
    quantity: z.number().positive().max(999999999.999).multipleOf(0.001),
    cost: z.number().nonnegative().max(999999999.9999).multipleOf(0.0001).optional(),
  })).min(1).max(100),
}).refine(({ type, document }) => document === undefined || document.startsWith(type), {
  path: ['document'], message: 'El folio debe empezar con el tipo de movimiento.',
}).refine(({ type, warehouse, destinationWarehouse }) => type === 'TR'
  ? destinationWarehouse !== undefined && destinationWarehouse !== warehouse : destinationWarehouse === undefined, {
  path: ['destinationWarehouse'], message: 'El traspaso requiere un almacén de destino distinto del origen.',
});

export const createMovementsRouter = (
  movements: ReadInventoryMovements,
  cancellation?: CancelInventoryMovement,
  capture?: CaptureInventoryMovements,
): Router => {
  const router = Router();
  router.get('/', async (request, response) => {
    response.json(await movements.search(searchSchema.parse(request.query)));
  });
  if (capture !== undefined) {
    router.get('/capture', async (_request, response) => {
      response.json(await capture.options());
    });
    router.post('/', async (request, response) => {
      const { document, reference, destinationWarehouse, lines, ...input } = adjustmentSchema.parse(request.body);
      const result = await capture.save({
        ...input,
        ...(document === undefined ? {} : { document }),
        ...(reference === undefined ? {} : { reference }),
        ...(destinationWarehouse === undefined ? {} : { destinationWarehouse }),
        lines: lines.map(({ cost, ...line }) => cost === undefined ? line : { ...line, cost }),
      });
      response.status(201).json(result);
    });
  }
  router.get('/:id', async (request, response) => {
    const { id } = idParamsSchema.parse(request.params);
    response.json(await movements.getById(id));
  });
  if (cancellation !== undefined) {
    router.delete('/:id', async (request, response) => {
      const { id } = idParamsSchema.parse(request.params);
      await cancellation.execute(id);
      response.status(204).send();
    });
  }
  return router;
};
