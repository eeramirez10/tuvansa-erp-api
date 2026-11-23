import type { PurchaseOrder, PurchaseOrderProps } from '../entities/purchase-order.js';
import type { PurchaseOrderIdentity, PurchaseOrderNavigationDirection, PurchaseOrderSearchCriteria, PurchaseOrderSearchResult } from '../repositories/purchase-orders-repository.js';
import type { PurchaseOrderEditLegacyDataSource, PurchaseOrderEditLine, PurchaseOrderEditRules, PurchaseOrderEditSnapshot, PurchaseOrderStockChange } from './purchase-order-edit-data-source.js';

export const localPurchaseOrderIdStart = 6500000000000;
export const isLocalPurchaseOrderId = (id: number) => id >= localPurchaseOrderIdStart;

export type PurchaseOrderCreateDefaults = {
  movement: string;
  today: string;
  from: string;
  dueAt: string;
  periodStart: string | null;
  periodEnd: string | null;
  warehouse: string;
  selectWarehouse: boolean;
  taxPercentage: number;
  discountLocked: boolean;
  maxLines: number;
  labels: string[];
  exchangeRates: number[];
  taxRates: number[];
};

export type PurchaseOrderWarehouse = { code: string; description: string };

export type PurchaseOrderSupplier = {
  supplier: PurchaseOrderProps['supplier'];
  rules: PurchaseOrderEditRules;
  terms: number;
  taxType: number;
  classifications: string[];
};

export type PurchaseOrderCreateInput = {
  requestKey: string;
  supplierCode: string;
  supplierOrderNumber: string;
  orderedAt: string;
  from: string;
  dueAt: string;
  warehouse: string;
  agent: string;
  discountPercentages: [number, number, number];
  taxPercentage: number;
  freight: number;
  insurance: number;
  other: number;
  otherLabel: string;
  onAccount: number;
  lines: PurchaseOrderEditLine[];
};

export type PurchaseOrderLocalMetadata = {
  rules: PurchaseOrderEditRules;
  terms: number;
  taxType: number;
  onAccount: number;
  exchangeRate: number;
  labels: string[];
  createdAt: string;
};

export type LocalPurchaseOrder = {
  order: PurchaseOrder;
  metadata: PurchaseOrderLocalMetadata;
  fingerprint: string;
};

export type NewPurchaseOrder = {
  header: Omit<PurchaseOrderProps, 'id' | 'number'>;
  metadata: PurchaseOrderLocalMetadata;
  document: Pick<PurchaseOrderEditSnapshot, 'amountInWords' | 'lines' | 'totals' | 'comments'>;
  stock: PurchaseOrderStockChange[];
};

export interface PurchaseOrderCreateLegacyDataSource extends Pick<PurchaseOrderEditLegacyDataSource, 'findProducts' | 'searchProducts'> {
  creationDefaults(): Promise<PurchaseOrderCreateDefaults | null>;
  creationSuppliers(query: string, exact?: boolean): Promise<PurchaseOrderSupplier[]>;
  creationWarehouses(): Promise<PurchaseOrderWarehouse[]>;
  hasPurchaseAgent(code: string): Promise<boolean>;
}

export interface PurchaseOrderCreateStorage {
  writable(): boolean;
  findLocal(id: number): Promise<LocalPurchaseOrder | null>;
  findLocalByNumber(number: string): Promise<LocalPurchaseOrder | null>;
  findLocalRequest(requestKey: string, fingerprint: string): Promise<PurchaseOrderIdentity | null>;
  searchLocal(criteria: PurchaseOrderSearchCriteria, excluded: PurchaseOrderIdentity[], matching: PurchaseOrderIdentity[], removed: PurchaseOrderIdentity[]): Promise<PurchaseOrderSearchResult>;
  findLocalAdjacent(number: string, direction: PurchaseOrderNavigationDirection, removed: PurchaseOrderIdentity[]): Promise<PurchaseOrder | null>;
  create(requestKey: string, fingerprint: string, order: NewPurchaseOrder): Promise<PurchaseOrderIdentity>;
}
