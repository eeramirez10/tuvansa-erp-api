import type { Order } from '../entities/order.js';
import type { OrderPanelResult } from '../repositories/order-panels-repository.js';

export interface DuplicateOrderInput {
  requestKey: string;
  revision: string;
  orderedAt: string;
}

export interface OrderDuplicateDataSource {
  previewDuplicate(id: number, companyId: number): Promise<OrderPanelResult>;
  duplicate(id: number, companyId: number, input: DuplicateOrderInput): Promise<Order>;
}
