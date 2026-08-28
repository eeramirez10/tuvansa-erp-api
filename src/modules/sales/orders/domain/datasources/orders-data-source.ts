import type { Order } from '../entities/order.js';
import type {
  DeleteOrderResult,
  OrderCreateValues,
  OrderNavigationDirection,
  OrderSearchCriteria,
  OrderSearchResult,
  OrderUpdateValues,
} from '../repositories/orders-repository.js';

export interface OrdersDataSource {
  findById(orderId: number): Promise<Order | null>;
  findByNumber(orderNumber: string): Promise<Order | null>;
  search(criteria: OrderSearchCriteria): Promise<OrderSearchResult>;
  findAdjacent(orderId: number, direction: OrderNavigationDirection): Promise<Order | null>;
  numberExists(number: string): Promise<boolean>;
  customerExists(customerId: number): Promise<boolean>;
  create(values: OrderCreateValues): Promise<Order>;
  update(orderId: number, values: OrderUpdateValues): Promise<Order | null>;
  delete(orderId: number): Promise<DeleteOrderResult>;
}
