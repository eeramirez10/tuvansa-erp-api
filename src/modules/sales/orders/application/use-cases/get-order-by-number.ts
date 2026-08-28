import { NotFoundError } from '../../../../../shared/domain/errors/not-found-error.js';
import type { OrdersRepository } from '../../domain/repositories/orders-repository.js';
import { toOrderResponse } from '../dtos/order-response.js';

export class GetOrderByNumber {
  constructor(private readonly repository: OrdersRepository) {}

  async execute(orderNumber: string) {
    const order = await this.repository.findByNumber(orderNumber);
    if (order === null) throw new NotFoundError('Pedido');
    return toOrderResponse(order);
  }
}
