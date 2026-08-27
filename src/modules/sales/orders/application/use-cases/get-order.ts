import { NotFoundError } from '../../../../../shared/domain/errors/not-found-error.js';
import type { OrdersRepository } from '../../domain/repositories/orders-repository.js';
import { toOrderResponse } from '../dtos/order-response.js';

export class GetOrder {
  constructor(private readonly repository: OrdersRepository) {}
  async execute(orderId: number) {
    const order = await this.repository.findById(orderId);
    if (order === null) throw new NotFoundError('Pedido');
    return toOrderResponse(order);
  }
}
