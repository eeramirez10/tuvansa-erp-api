import { ConflictError } from '../../../../../shared/domain/errors/conflict-error.js';
import { NotFoundError } from '../../../../../shared/domain/errors/not-found-error.js';
import type { OrdersRepository } from '../../domain/repositories/orders-repository.js';

export class DeleteOrder {
  constructor(private readonly repository: OrdersRepository) {}
  async execute(orderId: number): Promise<void> {
    const result = await this.repository.delete(orderId);
    if (result.status === 'not-found') throw new NotFoundError('Pedido');
    if (result.status === 'in-use') {
      throw new ConflictError(`El pedido tiene movimientos relacionados en ${result.relation}`, 'ORDER_IN_USE');
    }
  }
}
