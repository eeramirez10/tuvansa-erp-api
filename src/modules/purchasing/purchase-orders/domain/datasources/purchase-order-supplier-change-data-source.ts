import type { PurchaseOrderProps } from '../entities/purchase-order.js';
import type { PurchaseOrderIdentity } from '../repositories/purchase-orders-repository.js';

export type PurchaseOrderSupplierChangeInput = {
  supplierCode: string;
  revision: number;
  legacyVersion: string;
  classificationRevision: number;
};

export type PurchaseOrderSupplierChoice = {
  supplier: PurchaseOrderProps['supplier'];
  supplierDiscounts: [number, number];
  taxType: number;
};

export type PurchaseOrderSupplierChange = PurchaseOrderIdentity & PurchaseOrderSupplierChoice;
export type PurchaseOrderSupplierFilters = { code?: string | undefined; name?: string | undefined };

export interface PurchaseOrderSupplierChangeCatalog {
  changeSuppliers(filters: PurchaseOrderSupplierFilters, exact?: boolean): Promise<PurchaseOrderSupplierChoice[]>;
}

export interface PurchaseOrderSupplierChangeStorage {
  findSupplierChanges(ids?: number[]): Promise<PurchaseOrderSupplierChange[]>;
  saveSupplierChange(
    order: PurchaseOrderIdentity, baseStatus: string, previousSupplierId: number,
    input: PurchaseOrderSupplierChangeInput, choice: PurchaseOrderSupplierChoice, actorId: number,
  ): Promise<void>;
}
