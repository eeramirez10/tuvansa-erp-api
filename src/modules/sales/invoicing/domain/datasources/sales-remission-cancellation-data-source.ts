import type { MovementDocument } from '../../../../inventories/movements/domain/entities/inventory-movement.js';
import type { OrderProps } from '../../../orders/domain/entities/order.js';
import type { InvoiceProps } from '../entities/invoice.js';

export interface SalesRemissionCancellationResult {
  id: number;
  date: string;
  reason: string;
  regeneratedOrder: boolean;
}

export interface SalesRemissionCancellationInput {
  requestKey: string;
  date: string;
  reason: string;
  confirmed: true;
  regenerateOrder: boolean;
}

export interface SalesRemissionCancellationSource {
  id: number;
  number: string;
  issuedAt: string;
  customerId: number;
  orderId: number;
  orderNumber: string;
  warehouse: string;
  charge: number;
  invoice: InvoiceProps;
  movement: MovementDocument;
  order: OrderProps | null;
  lineEffects: { orderLineId: number; productId: number; quantity: number }[];
  hasCollection: boolean;
  lastCollectionReversalAt: string | null;
  alreadyRecorded: SalesRemissionCancellationResult | null;
}

export interface SalesRemissionCancellationCommand {
  companyId: number;
  userId: number;
  id: number;
  source: SalesRemissionCancellationSource;
  input: SalesRemissionCancellationInput;
  fingerprint: string;
  validate(source: SalesRemissionCancellationSource): void;
  regenerate(source: SalesRemissionCancellationSource, current: OrderProps): OrderProps;
}

export interface SalesRemissionCancellationDataSource {
  source(companyId: number, id: number): Promise<SalesRemissionCancellationSource | null>;
  findRequest(companyId: number, requestKey: string, fingerprint: string): Promise<SalesRemissionCancellationResult | null>;
  commit(command: SalesRemissionCancellationCommand): Promise<SalesRemissionCancellationResult>;
}
