import type { Order, OrderProps } from '../../domain/entities/order.js';

export type OrderResponse = OrderProps;
export const toOrderResponse = (order: Order): OrderResponse => order.toPrimitives();
