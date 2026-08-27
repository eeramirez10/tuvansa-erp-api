import type { OrderPanelsDataSource } from '../../domain/datasources/order-panels-data-source.js';
import type { OrderPanelKey, OrderPanelResult, OrderPanelsRepository } from '../../domain/repositories/order-panels-repository.js';

export class OrderPanelsRepositoryImpl implements OrderPanelsRepository {
  constructor(private readonly dataSource: OrderPanelsDataSource) {}
  getPanel(orderId: number, key: OrderPanelKey): Promise<OrderPanelResult | null> {
    return this.dataSource.getPanel(orderId, key);
  }
}
