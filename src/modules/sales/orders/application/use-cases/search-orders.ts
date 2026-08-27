import type { OrderSearchCriteria, OrdersRepository } from '../../domain/repositories/orders-repository.js';
import { toOrderResponse } from '../dtos/order-response.js';

export class SearchOrders {
  constructor(private readonly repository: OrdersRepository) {}
  async execute(criteria: Omit<OrderSearchCriteria, 'offset' | 'limit'> & { page: number; pageSize: number }) {
    const { page, pageSize, ...filters } = criteria;
    const result = await this.repository.search({ ...filters, offset: (page - 1) * pageSize, limit: pageSize });
    return {
      data: result.items.map(toOrderResponse),
      pagination: { page, pageSize, total: result.total, pages: Math.ceil(result.total / pageSize) },
    };
  }
}
