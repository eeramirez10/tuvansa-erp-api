import type { PurchaseReceptionNavigationDirection, PurchaseReceptionsRepository } from '../../domain/repositories/purchase-receptions-repository.js';
import { toPurchaseReceptionResponse } from '../dtos/purchase-reception-response.js';

export class NavigatePurchaseReception {
  constructor(private readonly repository: PurchaseReceptionsRepository) {}
  async execute(id: number, direction: PurchaseReceptionNavigationDirection) {
    const result = await this.repository.findAdjacent(id, direction);
    return result === null ? null : toPurchaseReceptionResponse(result);
  }
}
