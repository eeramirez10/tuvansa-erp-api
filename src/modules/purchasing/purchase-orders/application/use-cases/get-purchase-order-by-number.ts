import { NotFoundError } from '../../../../../shared/domain/errors/not-found-error.js';
import type { PurchaseOrdersRepository } from '../../domain/repositories/purchase-orders-repository.js';
import { toPurchaseOrderResponse } from '../dtos/purchase-order-response.js';

export class GetPurchaseOrderByNumber {
  constructor(private readonly repository: PurchaseOrdersRepository) {}
  async execute(number: string) {
    const result = await this.repository.findByNumber(number);
    if (result === null) throw new NotFoundError('Orden de compra');
    return toPurchaseOrderResponse(result);
  }
}
