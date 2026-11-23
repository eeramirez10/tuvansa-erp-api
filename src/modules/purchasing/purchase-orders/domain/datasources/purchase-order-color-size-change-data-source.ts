import type { PurchaseOrderEditSnapshot, PurchaseOrderStockChange } from './purchase-order-edit-data-source.js';

export const purchaseOrderColorSizeQuantityMin = -2147483648;
export const purchaseOrderColorSizeQuantityMax = 2147483647;

export interface PurchaseOrderColorSizeChangeInput {
  lineId: number;
  quantity: number;
  revision: number;
  legacyVersion: string;
}

export interface PurchaseOrderColorSizeChangeCell {
  lineId: number;
  productCode: string;
  root: string;
  color: string;
  size: string;
  quantity: number;
  fulfilled: number;
}

export interface PurchaseOrderColorSizeChangeStorage {
  saveColorSizeChange(snapshot: PurchaseOrderEditSnapshot, stock: PurchaseOrderStockChange[]): Promise<void>;
}
