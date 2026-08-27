import { ConflictError } from '../../../../../shared/domain/errors/conflict-error.js';
import type { OrderCreateValues, OrdersRepository } from '../../domain/repositories/orders-repository.js';
import { toOrderResponse } from '../dtos/order-response.js';

export class CreateOrder {
  constructor(private readonly repository: OrdersRepository) {}
  async execute(values: OrderCreateValues) {
    if (await this.repository.numberExists(values.number)) {
      throw new ConflictError('Ya existe un pedido con ese número', 'ORDER_NUMBER_EXISTS');
    }
    if (!(await this.repository.customerExists(values.customerId))) {
      throw new ConflictError('El cliente indicado no existe', 'ORDER_CUSTOMER_NOT_FOUND');
    }
    return toOrderResponse(await this.repository.create(values));
  }
}
