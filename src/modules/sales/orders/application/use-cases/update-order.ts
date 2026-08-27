import { ConflictError } from '../../../../../shared/domain/errors/conflict-error.js';
import { NotFoundError } from '../../../../../shared/domain/errors/not-found-error.js';
import type { OrdersRepository, OrderUpdateValues } from '../../domain/repositories/orders-repository.js';
import { toOrderResponse } from '../dtos/order-response.js';

export class UpdateOrder {
  constructor(private readonly repository: OrdersRepository) {}
  async execute(orderId: number, values: OrderUpdateValues) {
    if (values.customerId !== undefined && !(await this.repository.customerExists(values.customerId))) {
      throw new ConflictError('El cliente indicado no existe', 'ORDER_CUSTOMER_NOT_FOUND');
    }
    const order = await this.repository.update(orderId, values);
    if (order === null) throw new NotFoundError('Pedido');
    return toOrderResponse(order);
  }
}
