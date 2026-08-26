import { ConflictError } from '../../../../../shared/domain/errors/conflict-error.js';
import { NotFoundError } from '../../../../../shared/domain/errors/not-found-error.js';
import type { ProductsRepository } from '../../domain/repositories/products-repository.js';

export class DeleteProduct {
  constructor(private readonly repository: ProductsRepository) {}

  async execute(productId: number): Promise<void> {
    const result = await this.repository.delete(productId);
    if (result.status === 'not-found') throw new NotFoundError('Producto');
    if (result.status === 'in-use') {
      throw new ConflictError(
        `El producto tiene registros relacionados en ${result.relation}`,
        'PRODUCT_IN_USE',
      );
    }
  }
}
