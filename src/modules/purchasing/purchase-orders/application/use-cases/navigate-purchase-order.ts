import type { PurchaseOrderNavigationDirection, PurchaseOrdersRepository } from '../../domain/repositories/purchase-orders-repository.js';
import { toPurchaseOrderResponse } from '../dtos/purchase-order-response.js';

export class NavigatePurchaseOrder {
  constructor(private readonly repository: PurchaseOrdersRepository) {}
  async execute(id: number, direction: PurchaseOrderNavigationDirection) {
    const result = await this.repository.findAdjacent(id, direction);
    return result === null ? null : toPurchaseOrderResponse(result);
  }
}
