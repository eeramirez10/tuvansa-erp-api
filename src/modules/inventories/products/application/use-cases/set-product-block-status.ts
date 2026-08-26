import { NotFoundError } from '../../../../../shared/domain/errors/not-found-error.js';
import type {
  ProductBlockStatus,
  ProductPanelsRepository,
} from '../../domain/repositories/product-panels-repository.js';

export class SetProductBlockStatus {
  constructor(private readonly repository: ProductPanelsRepository) {}

  async execute(productId: number, blocked: boolean): Promise<ProductBlockStatus> {
    const result = await this.repository.setBlocked(productId, blocked);
    if (result === null) throw new NotFoundError('Producto');
    return result;
  }
}
