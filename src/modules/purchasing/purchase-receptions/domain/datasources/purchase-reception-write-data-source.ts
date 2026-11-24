import type { MovementHeader, MovementLine } from '../../../../inventories/movements/domain/entities/inventory-movement.js';
import type { InventoryPepsCostBasis } from '../../../../inventories/movements/domain/entities/inventory-peps-cost.js';
import type { PurchaseOrderProps } from '../../../purchase-orders/domain/entities/purchase-order.js';
import type { PurchaseReceptionLine, PurchaseReceptionProps } from '../entities/purchase-reception.js';
import type {
  PurchaseOrderReceiptEffect, PurchaseOrderReceiptLineInput, PurchaseOrderReceiptPolicy,
} from '../entities/purchase-reception-order-effect.js';

export interface PurchaseReceptionCreateInput {
  requestKey: string;
  revision: number;
  legacyVersion: string;
  receivedAt: string;
  warehouse: string;
  supplierReference: string;
  retireCompletedOrder?: boolean;
  lines: PurchaseOrderReceiptLineInput[];
}

export interface PurchaseReceptionWriteContext {
  order: PurchaseOrderProps;
  revision: number;
  legacyVersion: string;
  sourceVersion?: string;
  supplierRevision?: number;
  amountInWords?: string | null;
  policy: PurchaseOrderReceiptPolicy;
  warehouses: { code: string; name: string }[];
  defaults: { receivedAt: string; warehouse: string };
  reason: string | null;
}

export interface PurchaseReceptionPosting {
  document: Omit<PurchaseReceptionProps, 'id' | 'number' | 'lines'>;
  movement: Omit<MovementHeader, 'id' | 'document' | 'userId'>;
  lines: {
    orderLineId: number;
    reception: Omit<PurchaseReceptionLine, 'id'>;
    movement: Omit<MovementLine, 'id' | 'userId'>;
    pepsLayer?: { date: string | null; customsEntry: string; customsOffice: string; costBasis: InventoryPepsCostBasis };
  }[];
  payable: { amount: number; currencyId: number; exchangeRate: number; dueAt: string } | null;
  accounting: { type: string; lines: { account: string; department: string; debit: number; credit: number }[] } | null;
}

export interface PurchaseReceptionActor {
  companyId: number;
  userId: number;
}

export interface PurchaseReceptionWriteReferences {
  context(companyId: number, orderId: number): Promise<PurchaseReceptionWriteContext | null>;
  posting(
    context: PurchaseReceptionWriteContext,
    input: PurchaseReceptionCreateInput,
    effect: PurchaseOrderReceiptEffect,
  ): Promise<PurchaseReceptionPosting>;
}

export interface PurchaseReceptionWriteCommand {
  actor: PurchaseReceptionActor;
  input: PurchaseReceptionCreateInput;
  fingerprint: string;
  context: PurchaseReceptionWriteContext;
  effect: PurchaseOrderReceiptEffect;
  posting: PurchaseReceptionPosting;
}

export interface PurchaseReceptionSaveResult {
  reception: PurchaseReceptionProps;
  orderComplete: boolean;
  orderRetired: boolean;
}

export interface PurchaseReceptionWriteDataSource {
  writable(): boolean;
  // A matching key with a different fingerprint is a conflict.
  findRequest(companyId: number, requestKey: string, fingerprint: string): Promise<PurchaseReceptionSaveResult | null>;
  // Recheck the idempotency key and source revision under the purchase-order lock. Persist the
  // receipt, order and stock changes, payable, and accounting entries in the same transaction.
  commit(command: PurchaseReceptionWriteCommand): Promise<PurchaseReceptionSaveResult>;
}
