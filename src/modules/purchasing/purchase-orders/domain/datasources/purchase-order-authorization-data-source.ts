import type { PurchaseOrderAuthorizationDirection, PurchaseOrderAuthorizationLevel } from '../entities/purchase-order-authorization.js';
import type { PurchaseOrderIdentity } from '../repositories/purchase-orders-repository.js';
import type { PurchaseOrderSupplierChangeMode } from './purchase-order-supplier-change-data-source.js';

export type PurchaseOrderAuthorizationInput = {
  level: PurchaseOrderAuthorizationLevel;
  direction: PurchaseOrderAuthorizationDirection;
  revision: number;
  legacyVersion: string;
  classificationRevision: number;
  status: string;
};

export type PurchaseOrderAuthorizationEvent = {
  level: PurchaseOrderAuthorizationLevel;
  direction: PurchaseOrderAuthorizationDirection;
  actorId: number;
  occurredAt: string;
};

export interface PurchaseOrderAuthorizationAccess {
  enabled(): boolean;
  levels(): PurchaseOrderAuthorizationLevel[];
  supplierChangeEnabled(mode: PurchaseOrderSupplierChangeMode): boolean;
  verify(key: string | undefined, action: PurchaseOrderAuthorizationLevel | 'supplier-change' | 'supplier-change-action'): Promise<number>;
}

export interface PurchaseOrderAuthorizationStorage {
  findAuthorizationEvents(order: PurchaseOrderIdentity): Promise<PurchaseOrderAuthorizationEvent[]>;
  saveAuthorization(
    order: PurchaseOrderIdentity, baseClassifications: string[], input: PurchaseOrderAuthorizationInput, next: string, actorId: number,
  ): Promise<void>;
}
