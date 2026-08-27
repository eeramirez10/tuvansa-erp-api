import type { OrderNavigationDirection, OrdersRepository } from '../../domain/repositories/orders-repository.js';
import { toOrderResponse } from '../dtos/order-response.js';

export class NavigateOrder {
  constructor(private readonly repository: OrdersRepository) {}
  async execute(orderId: number, direction: OrderNavigationDirection) {
    const order = await this.repository.findAdjacent(orderId, direction);
    return order === null ? null : toOrderResponse(order);
  }
}
