import type { PurchaseOrderEditSnapshot, PurchaseOrderStockChange } from './purchase-order-edit-data-source.js';
import type { PurchaseOrderIdentity } from '../repositories/purchase-orders-repository.js';

export type PurchaseOrderRemoveInput = Pick<PurchaseOrderEditSnapshot, 'number' | 'revision' | 'legacyVersion'>;

export interface PurchaseOrderRemovalStorage {
  writable(): boolean;
  findRemoved(ids?: number[]): Promise<PurchaseOrderIdentity[]>;
  remove(snapshot: PurchaseOrderEditSnapshot, stock: PurchaseOrderStockChange[]): Promise<void>;
}
