import type { OrderProps } from '../entities/order.js';

export interface OrderOverlay {
  document: OrderProps;
  base: OrderProps | null;
  deleted: boolean;
  revision: number;
}
export type OrderAuthorizationEvent = NonNullable<OrderProps['authorizationChange']> & { authorized: boolean };

export interface OrderOverlayDataSource {
  readonly configured: boolean;
  get(id: number): Promise<OrderOverlay | null>;
  list(): Promise<OrderOverlay[]>;
  authorizationHistory(id: number): Promise<OrderAuthorizationEvent[]>;
  create(build: (id: number) => Promise<OrderProps>): Promise<OrderProps>;
  change(id: number, base: OrderProps | null, operation: 'update' | 'delete' | 'convert' | 'assignment' | 'authorization',
    transform: (current: OrderProps, revision: number) => Promise<OrderProps | null>): Promise<OrderOverlay | null>;
}
