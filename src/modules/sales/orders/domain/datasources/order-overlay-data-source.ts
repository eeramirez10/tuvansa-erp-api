import type { OrderProps } from '../entities/order.js';

export interface OrderOverlay {
  document: OrderProps;
  base: OrderProps | null;
  deleted: boolean;
  revision: number;
}
export interface OrderOverlayDataSource {
  readonly configured: boolean;
  get(id: number): Promise<OrderOverlay | null>;
  list(): Promise<OrderOverlay[]>;
  create(build: (id: number) => Promise<OrderProps>): Promise<OrderProps>;
  change(id: number, base: OrderProps | null, operation: 'update' | 'delete' | 'convert',
    transform: (current: OrderProps) => Promise<OrderProps | null>): Promise<OrderOverlay | null>;
}
