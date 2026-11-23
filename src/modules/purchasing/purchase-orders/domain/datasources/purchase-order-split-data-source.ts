import type { NewPurchaseOrder } from './purchase-order-create-data-source.js';
import type { PurchaseOrderEditSnapshot, PurchaseOrderStockChange } from './purchase-order-edit-data-source.js';
import type { PurchaseOrderIdentity } from '../repositories/purchase-orders-repository.js';

export type PurchaseOrderSplitInput = Pick<PurchaseOrderEditSnapshot, 'revision' | 'legacyVersion'> & {
  requestKey: string;
  lineIds: number[];
};

export interface PurchaseOrderSplitReference {
  counter: number;
  occupied: string[];
}

export interface PurchaseOrderSplitLegacy {
  splitReferences(id: number, number: string): Promise<PurchaseOrderSplitReference>;
  commentCurrencyName(id: number): Promise<string>;
}

export interface PurchaseOrderSplitStorage {
  saveSplit(
    requestKey: string, fingerprint: string, source: PurchaseOrderEditSnapshot,
    sourceStock: PurchaseOrderStockChange[], split: NewPurchaseOrder, references: PurchaseOrderSplitReference,
  ): Promise<PurchaseOrderIdentity>;
}
