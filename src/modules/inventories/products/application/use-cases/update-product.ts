import { NotFoundError } from '../../../../../shared/domain/errors/not-found-error.js';
import type { ProductsRepository } from '../../domain/repositories/products-repository.js';
import {
  toProductWriteValues,
  type UpdateProductInput,
} from '../dtos/product-mutation-input.js';
import { toProductResponse, type ProductResponse } from '../dtos/product-response.js';
import { validateProductValues } from '../services/validate-product-values.js';

export class UpdateProduct {
  constructor(private readonly repository: ProductsRepository) {}

  async execute(productId: number, input: UpdateProductInput): Promise<ProductResponse> {
    const values = toProductWriteValues(input);
    await validateProductValues(this.repository, values);
    const product = await this.repository.update(productId, values, input.revision);
    if (product === null) throw new NotFoundError('Producto');
    return toProductResponse(product);
  }

  async options(productId: number) {
    if (await this.repository.findById(productId) === null) throw new NotFoundError('Producto');
    return { units: await this.repository.listUnits?.() ?? [] };
  }
}
