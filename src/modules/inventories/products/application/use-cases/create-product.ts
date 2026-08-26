import { ConflictError } from '../../../../../shared/domain/errors/conflict-error.js';
import type { ProductsRepository } from '../../domain/repositories/products-repository.js';
import {
  toProductCreateValues,
  type CreateProductInput,
} from '../dtos/product-mutation-input.js';
import { toProductResponse, type ProductResponse } from '../dtos/product-response.js';
import { validateProductValues } from '../services/validate-product-values.js';

export class CreateProduct {
  constructor(private readonly repository: ProductsRepository) {}

  async execute(input: CreateProductInput): Promise<ProductResponse> {
    if (await this.repository.codeExists(input.code)) {
      throw new ConflictError('Ya existe un producto con ese codigo', 'PRODUCT_CODE_EXISTS');
    }
    const values = toProductCreateValues(input);
    await validateProductValues(this.repository, values);
    return toProductResponse(await this.repository.create(values));
  }
}
