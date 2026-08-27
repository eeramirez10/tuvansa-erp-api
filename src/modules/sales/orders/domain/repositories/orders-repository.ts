import type { Order } from '../entities/order.js';

export type OrderNavigationDirection = 'previous' | 'next';

export interface OrderSearchCriteria {
  query?: string;
  orderNumber?: string;
  customerOrderNumber?: string;
  status?: string;
  customerCode?: string;
  orderedAt?: string;
  dueAt?: string;
  agent?: string;
  branch?: number;
  warehouse?: string;
  authorization?: string;
  minimumFulfillmentPercentage?: number;
  from?: string;
  to?: string;
  offset: number;
  limit: number;
}

export interface OrderSearchResult { items: Order[]; total: number }

export interface OrderLineWriteValues {
  productId: number;
  quantity: number;
  price: number;
  discount?: number;
}

export interface OrderCreateValues {
  number: string;
  customerId: number;
  customerOrderNumber?: string;
  orderedAt: string;
  from?: string;
  dueAt?: string;
  branch?: number;
  department?: string;
  attentionCode?: string;
  termsDays?: number;
  warehouse?: string;
  currencyId?: number;
  initial?: boolean;
  observations?: string;
  lines: OrderLineWriteValues[];
}

export type OrderUpdateValues = Partial<Omit<OrderCreateValues, 'number' | 'customerId' | 'lines'>> & {
  customerId?: number;
  status?: string;
  classifications?: string[];
  lines?: OrderLineWriteValues[];
};

export type DeleteOrderResult =
  | { status: 'deleted' }
  | { status: 'not-found' }
  | { status: 'in-use'; relation: string };

export interface OrdersRepository {
  findById(orderId: number): Promise<Order | null>;
  search(criteria: OrderSearchCriteria): Promise<OrderSearchResult>;
  findAdjacent(orderId: number, direction: OrderNavigationDirection): Promise<Order | null>;
  numberExists(number: string): Promise<boolean>;
  customerExists(customerId: number): Promise<boolean>;
  create(values: OrderCreateValues): Promise<Order>;
  update(orderId: number, values: OrderUpdateValues): Promise<Order | null>;
  delete(orderId: number): Promise<DeleteOrderResult>;
}
