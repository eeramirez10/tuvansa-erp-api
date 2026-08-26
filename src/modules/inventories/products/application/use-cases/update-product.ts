import { ConflictError } from '../../../../../shared/domain/errors/conflict-error.js';
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
    if (input.code !== undefined && await this.repository.codeExists(input.code, productId)) {
      throw new ConflictError('Ya existe un producto con ese codigo', 'PRODUCT_CODE_EXISTS');
    }
    const values = toProductWriteValues(input);
    await validateProductValues(this.repository, values);
    const product = await this.repository.update(productId, values);
    if (product === null) throw new NotFoundError('Producto');
    return toProductResponse(product);
  }
}
