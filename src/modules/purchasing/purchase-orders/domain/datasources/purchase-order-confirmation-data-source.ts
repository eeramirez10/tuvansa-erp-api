import type { PurchaseOrderEditSnapshot } from './purchase-order-edit-data-source.js';

export type PurchaseOrderConfirmationMode = 'confirm' | 'unconfirm';
export type PurchaseOrderConfirmationInput = Pick<PurchaseOrderEditSnapshot, 'revision' | 'legacyVersion'> & {
  mode: PurchaseOrderConfirmationMode;
};

export type PurchaseOrderConfirmedStock = { productId: number; assigned: number };

export interface PurchaseOrderConfirmationStorage {
  saveConfirmation(snapshot: PurchaseOrderEditSnapshot, stock: PurchaseOrderConfirmedStock[], classifications: string[], marker: string): Promise<void>;
}
