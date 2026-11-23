import type { NewPurchaseOrder } from './purchase-order-create-data-source.js';
import type { PurchaseOrderEditSnapshot } from './purchase-order-edit-data-source.js';
import type { PurchaseOrderIdentity } from '../repositories/purchase-orders-repository.js';

export interface PurchaseOrderDuplicateFields {
  supplierCode: string;
  percentage: number;
  orderedAt: string;
  from: string | null;
  supplierOrderNumber: string;
  branchCode: string;
}

export type PurchaseOrderDuplicateInput = Pick<PurchaseOrderEditSnapshot, 'revision' | 'legacyVersion'> & {
  requestKey: string;
  markedOnly: boolean;
  fields: PurchaseOrderDuplicateFields;
};

export interface PurchaseOrderDuplicateStorage {
  saveDuplicate(requestKey: string, fingerprint: string, source: PurchaseOrderEditSnapshot, duplicate: NewPurchaseOrder): Promise<PurchaseOrderIdentity>;
}
