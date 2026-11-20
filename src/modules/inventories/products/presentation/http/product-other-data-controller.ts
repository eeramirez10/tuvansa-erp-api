import type { RequestHandler } from 'express';
import { z } from 'zod';
import type { EditProductOtherData } from '../../application/use-cases/edit-product-other-data.js';
import { productOtherDataFields, type ProductOtherDataValues } from '../../domain/entities/product-other-data.js';

const productParams = z.object({ productId: z.coerce.number().int().positive() });
const pagination = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(500).default(100),
});

function fieldSchema(field: (typeof productOtherDataFields)[string]) {
  if (field.kind === 'boolean') return z.boolean();
  if (field.kind === 'date') return z.iso.date().min(10).max(10);
  if (field.kind === 'text') {
    const value = z.string().trim().min(field.minLength ?? 0).max(field.maxLength ?? 120);
    return field.uppercase ? value.transform((entry) => entry.toUpperCase()).pipe(value) : value;
  }
  const limit = Number.MAX_SAFE_INTEGER / (10 ** (field.decimals ?? 0));
  let value = z.number().min(-limit).max(field.maximum ?? limit);
  if (field.minimum !== undefined) value = value.min(field.minimum);
  if (field.exclusiveMinimum !== undefined) value = value.gt(field.exclusiveMinimum);
  if (field.decimals !== undefined) value = value.multipleOf(1 / (10 ** field.decimals));
  return value;
}

const changes = z.strictObject(Object.fromEntries(Object.entries(productOtherDataFields)
  .filter(([, field]) => field.editable)
  .map(([key, field]) => [key, fieldSchema(field).optional()])));

const body = z.strictObject({
  revision: z.number().int().min(0).max(2_147_483_646),
  changes,
});

export class ProductOtherDataController {
  constructor(private readonly otherData: EditProductOtherData) {}

  get: RequestHandler = async (request, response) => {
    const { productId } = productParams.parse(request.params);
    const { page, pageSize } = pagination.parse(request.query);
    response.json(await this.otherData.get(productId, page, pageSize));
  };

  save: RequestHandler = async (request, response) => {
    const { productId } = productParams.parse(request.params);
    const { revision, changes: requested } = body.parse(request.body);
    const defined: ProductOtherDataValues = {};
    for (const [key, value] of Object.entries(requested)) {
      if (value !== undefined) defined[key] = value;
    }
    response.json(await this.otherData.save(productId, revision, defined));
  };
}
