import type { MovementDocument } from '../../../../inventories/movements/domain/entities/inventory-movement.js';
import type { PurchaseOrderProps } from '../../../purchase-orders/domain/entities/purchase-order.js';
import type { PurchaseOrderEditSnapshot } from '../../../purchase-orders/domain/datasources/purchase-order-edit-data-source.js';
import type { PurchaseReceptionProps } from '../entities/purchase-reception.js';
import type { ReceiptCancellationLine } from '../entities/purchase-reception-cancellation.js';
import type { PostingReversalInput, PostingReversalResult } from './purchase-posting-reversal-data-source.js';
import type { PurchaseReceptionActor, PurchaseReceptionPosting } from './purchase-reception-write-data-source.js';

export interface ReceiptCancellationSource {
  id: number;
  orderId: number;
  orderNumber: string;
  receipt: PurchaseReceptionProps;
  orderLineEffects: ReceiptCancellationLine[];
  movement: MovementDocument;
  accounting: (NonNullable<PurchaseReceptionPosting['accounting']> & { number: string }) | null;
  payable: PurchaseReceptionPosting['payable'];
  orderRetired: boolean;
  paymentActive: boolean;
  lastReversalDate: string | null;
  alreadyRecorded: PostingReversalResult | null;
  piecesInvoiced?: boolean;
  historical?: { version: string; blockedReason: string | null };
}

export interface HistoricalReceiptCancellationSource {
  read(receiptId: number): Promise<ReceiptCancellationSource | null>;
  inventory(warehouse: string, productIds: number[]): Promise<Map<number, { onHand: number; assigned: number }>>;
}

export interface ReceiptCancellationOrder {
  order: PurchaseOrderProps;
  revision: number;
  legacyVersion: string;
  supplierRevision: number;
  amountInWords: string | null;
  stale: boolean;
}

export interface ReceiptCancellationStock {
  warehouse: string;
  requests: { productId: number; quantity: number; legacyOnHand: number; legacyAssigned: number }[];
  layers?: { receiptId: number; lines: { lotId: number; productId: number; quantity: number }[] };
}
export interface ReceiptCancellationReferences {
  cancellationOrder(orderId: number): Promise<ReceiptCancellationOrder | null>;
  inventory(warehouse: string, productIds: number[]): Promise<Map<number, { onHand: number; assigned: number }>>;
}

export interface ReceiptCancellationCommand {
  actor: PurchaseReceptionActor;
  input: PostingReversalInput;
  fingerprint: string;
  source: ReceiptCancellationSource;
  order: PurchaseOrderEditSnapshot;
  pending: { productId: number; pendingDelta: number; assigned: number }[];
  supplierRevision: number;
  stock: ReceiptCancellationStock;
  validate(source: ReceiptCancellationSource): void;
}

export interface PurchaseReceptionCancellationDataSource {
  source(companyId: number, receiptId: number): Promise<ReceiptCancellationSource | null>;
  findRequest(companyId: number, requestKey: string, fingerprint: string): Promise<PostingReversalResult | null>;
  checkStock(stock: ReceiptCancellationStock): Promise<void>;
  commit(command: ReceiptCancellationCommand): Promise<PostingReversalResult>;
}
