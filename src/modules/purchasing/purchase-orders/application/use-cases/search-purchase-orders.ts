import type { PurchaseOrderSearchCriteria, PurchaseOrdersRepository } from '../../domain/repositories/purchase-orders-repository.js';
import { toPurchaseOrderResponse } from '../dtos/purchase-order-response.js';

export class SearchPurchaseOrders {
  constructor(private readonly repository: PurchaseOrdersRepository) {}
  async execute(criteria: Omit<PurchaseOrderSearchCriteria, 'offset' | 'limit'> & { page: number; pageSize: number }) {
    const { page, pageSize, ...filters } = criteria;
    const result = await this.repository.search({ ...filters, offset: (page - 1) * pageSize, limit: pageSize });
    return {
      data: result.items.map(toPurchaseOrderResponse),
      pagination: { page, pageSize, total: result.total, pages: Math.ceil(result.total / pageSize) },
    };
  }
}
