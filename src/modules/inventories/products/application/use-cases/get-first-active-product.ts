import { NotFoundError } from '../../../../../shared/domain/errors/not-found-error.js';
import type { ProductsRepository } from '../../domain/repositories/products-repository.js';
import { toProductResponse, type ProductResponse } from '../dtos/product-response.js';

export class GetFirstActiveProduct {
  constructor(private readonly repository: ProductsRepository) {}

  async execute(): Promise<ProductResponse> {
    const product = await this.repository.findFirstActive();
    if (product === null) throw new NotFoundError('Producto');
    return toProductResponse(product);
  }
}
