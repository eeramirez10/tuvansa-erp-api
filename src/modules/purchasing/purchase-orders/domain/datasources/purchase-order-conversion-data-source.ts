import type { PurchaseOrderEditSnapshot, PurchaseOrderStockChange } from './purchase-order-edit-data-source.js';
import type { PurchaseOrderIdentity } from '../repositories/purchase-orders-repository.js';

export type PurchaseOrderConversionKind = NonNullable<PurchaseOrderEditSnapshot['documentKind']>;

export type PurchaseOrderConversionInput = Pick<PurchaseOrderEditSnapshot, 'legacyVersion' | 'revision'> & {
  target: PurchaseOrderConversionKind;
};

export type PurchaseOrderKindOverride = PurchaseOrderIdentity & { documentKind: PurchaseOrderConversionKind };

export interface PurchaseOrderConversionStorage {
  findKindOverrides(): Promise<PurchaseOrderKindOverride[]>;
  saveConversion(snapshot: PurchaseOrderEditSnapshot, stock: PurchaseOrderStockChange[]): Promise<void>;
}
