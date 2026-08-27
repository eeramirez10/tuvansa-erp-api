import type { OrderPanelKey, OrderPanelResult } from '../repositories/order-panels-repository.js';

export interface OrderPanelsDataSource {
  getPanel(orderId: number, key: OrderPanelKey): Promise<OrderPanelResult | null>;
}
