import { NotFoundError } from '../../../../../shared/domain/errors/not-found-error.js';
import type {
  ProductNavigationDirection,
  ProductsRepository,
} from '../../domain/repositories/products-repository.js';
import { toProductResponse, type ProductResponse } from '../dtos/product-response.js';

export class NavigateProduct {
  constructor(private readonly repository: ProductsRepository) {}

  async execute(
    productId: number,
    direction: ProductNavigationDirection,
  ): Promise<ProductResponse | null> {
    if (await this.repository.findById(productId) === null) throw new NotFoundError('Producto');
    const product = await this.repository.findAdjacent(productId, direction);
    return product === null ? null : toProductResponse(product);
  }
}
