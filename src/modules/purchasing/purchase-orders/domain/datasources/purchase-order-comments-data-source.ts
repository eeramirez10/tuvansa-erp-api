import type { PurchaseOrderEditSnapshot } from './purchase-order-edit-data-source.js';
import type { PurchaseOrderCommentFields } from '../entities/purchase-order-comments.js';
import type { PurchaseOrderIdentity } from '../repositories/purchase-orders-repository.js';
import type { PurchaseOrderPanelResult } from '../repositories/purchase-orders-repository.js';

export type PurchaseOrderCommentsInput = Pick<PurchaseOrderEditSnapshot, 'revision' | 'legacyVersion'> & {
  fields: PurchaseOrderCommentFields;
};

export type PurchaseOrderCommentSearchOverride = PurchaseOrderIdentity & Pick<PurchaseOrderCommentFields, 'dueAt' | 'supplierOrderNumber'>;

export interface PurchaseOrderCommentsStorage {
  saveComments(snapshot: PurchaseOrderEditSnapshot): Promise<void>;
  findCommentOverrides(): Promise<PurchaseOrderCommentSearchOverride[]>;
}

export interface PurchaseOrderCommentsLegacy {
  readComments(id: number): Promise<PurchaseOrderPanelResult | null>;
  commentCurrencyName(id: number): Promise<string>;
}
