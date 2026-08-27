import type { OrdersDataSource } from '../../domain/datasources/orders-data-source.js';
import type { Order } from '../../domain/entities/order.js';
import type {
  DeleteOrderResult, OrderCreateValues, OrderNavigationDirection, OrderSearchCriteria,
  OrderSearchResult, OrdersRepository, OrderUpdateValues,
} from '../../domain/repositories/orders-repository.js';

export class OrdersRepositoryImpl implements OrdersRepository {
  constructor(private readonly dataSource: OrdersDataSource) {}
  findById(orderId: number): Promise<Order | null> { return this.dataSource.findById(orderId); }
  search(criteria: OrderSearchCriteria): Promise<OrderSearchResult> { return this.dataSource.search(criteria); }
  findAdjacent(orderId: number, direction: OrderNavigationDirection): Promise<Order | null> {
    return this.dataSource.findAdjacent(orderId, direction);
  }
  numberExists(number: string): Promise<boolean> { return this.dataSource.numberExists(number); }
  customerExists(customerId: number): Promise<boolean> { return this.dataSource.customerExists(customerId); }
  create(values: OrderCreateValues): Promise<Order> { return this.dataSource.create(values); }
  update(orderId: number, values: OrderUpdateValues): Promise<Order | null> { return this.dataSource.update(orderId, values); }
  delete(orderId: number): Promise<DeleteOrderResult> { return this.dataSource.delete(orderId); }
}
