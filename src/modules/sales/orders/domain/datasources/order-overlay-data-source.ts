import type { DuplicateOrderInput } from './order-duplicate-data-source.js';
import type { OrderProps } from '../entities/order.js';
import type { OrderNumberSeries } from '../entities/order-number-series.js';

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
  previewNumber(series: OrderNumberSeries): Promise<string>;
  create(build: (id: number, number?: string) => Promise<OrderProps>,
    numbering?: OrderNumberSeries | string): Promise<OrderProps>;
  findDuplicate(sourceId: number, input: DuplicateOrderInput): Promise<OrderProps | null>;
  createDuplicate(sourceId: number, input: DuplicateOrderInput, expectedLocalRevision: number | null,
    build: (id: number, number?: string) => Promise<OrderProps>, series: OrderNumberSeries): Promise<OrderProps>;
  change(id: number, base: OrderProps | null, operation: 'update' | 'delete' | 'convert' | 'assignment' | 'authorization',
    transform: (current: OrderProps, revision: number) => Promise<OrderProps | null>): Promise<OrderOverlay | null>;
}
