import type { RequestHandler } from 'express';
import { z } from 'zod';
import type { EditProductClassification } from '../../application/use-cases/edit-product-classification.js';

const productParams = z.object({ productId: z.coerce.number().int().positive() });
const pagination = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(500).default(100),
});
const classificationBody = z.object({
  revision: z.number().int().min(0).max(2_147_483_646),
  changes: z.record(z.string().regex(/^[1-9A-K]$/), z.string().trim().min(1).max(4)),
  rebuildFamily: z.boolean().optional(),
}).strict();

export class ProductClassificationsController {
  constructor(private readonly classification: EditProductClassification) {}

  get: RequestHandler = async (request, response) => {
    const { productId } = productParams.parse(request.params);
    const { page, pageSize } = pagination.parse(request.query);
    response.json(await this.classification.get(productId, page, pageSize));
  };

  save: RequestHandler = async (request, response) => {
    const { productId } = productParams.parse(request.params);
    response.json(await this.classification.save(productId, classificationBody.parse(request.body)));
  };
}
