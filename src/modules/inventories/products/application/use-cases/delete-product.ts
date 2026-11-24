import { ConflictError } from '../../../../../shared/domain/errors/conflict-error.js';
import { NotFoundError } from '../../../../../shared/domain/errors/not-found-error.js';
import type { ProductRemovalConfirmation, ProductsRepository } from '../../domain/repositories/products-repository.js';

export class DeleteProduct {
  constructor(private readonly repository: ProductsRepository) {}

  async preview(productId: number) {
    const preview = await this.repository.removal?.(productId);
    if (!preview) throw new NotFoundError('Producto');
    return preview;
  }

  async execute(productId: number, confirmation?: ProductRemovalConfirmation): Promise<void> {
    const result = await this.repository.delete(productId, confirmation);
    if (result.status === 'not-found') throw new NotFoundError('Producto');
    if (result.status === 'in-use') {
      throw new ConflictError(
        `El producto tiene registros relacionados en ${result.relation}`,
        'PRODUCT_IN_USE',
      );
    }
  }
}
