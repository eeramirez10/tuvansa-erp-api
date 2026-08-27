import { NotFoundError } from '../../../../../shared/domain/errors/not-found-error.js';
import type { OrderPanelKey, OrderPanelsRepository } from '../../domain/repositories/order-panels-repository.js';

export class GetOrderPanel {
  constructor(private readonly repository: OrderPanelsRepository) {}
  async execute(orderId: number, key: OrderPanelKey) {
    const panel = await this.repository.getPanel(orderId, key);
    if (panel === null) throw new NotFoundError('Pedido');
    return { data: panel };
  }
}
