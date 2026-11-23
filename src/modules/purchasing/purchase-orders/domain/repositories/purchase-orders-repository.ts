import type { PurchaseOrder } from '../entities/purchase-order.js';

export type PurchaseOrderNavigationDirection = 'previous' | 'next';

export interface PurchaseOrderSearchCriteria {
  query?: string;
  orderNumber?: string;
  supplierOrderNumber?: string;
  supplierCode?: string;
  orderedAt?: string;
  dueAt?: string;
  agent?: string;
  documentType?: number;
  offset: number;
  limit: number;
}

export interface PurchaseOrderSearchResult {
  items: PurchaseOrder[];
  total: number;
}

export type PurchaseOrderPanelKey = 'receipts' | 'classifications' | 'comments' | 'ct' | 'pieces';

export interface PurchaseOrderPanelResult {
  purchaseOrder: { id: number; number: string };
  key: PurchaseOrderPanelKey;
  section: 'actions';
  button: string;
  source: 'mysql' | 'mysql+postgres' | 'postgres';
  items: Array<Record<string, unknown>>;
  summary?: Record<string, unknown>;
}

export type PurchaseOrderIdentity = { id: number; number: string };
export type SavedPurchaseOrderClassifications = PurchaseOrderIdentity & { current: string[]; revision: number };
export type PurchaseOrderClassifier = { classifier: number; code: string; description: string; compositeCode: string };
export type PurchaseOrderClassificationPanel = Omit<PurchaseOrderPanelResult, 'items' | 'summary'> & {
  items: PurchaseOrderClassifier[];
  summary: { current: string[]; labels: string[]; revision: number; canWrite: boolean };
};
export type PurchaseOrderClassificationUpdate = { current: string[]; revision: number };

export interface PurchaseOrdersRepository {
  findById(id: number): Promise<PurchaseOrder | null>;
  findByNumber(number: string): Promise<PurchaseOrder | null>;
  search(criteria: PurchaseOrderSearchCriteria): Promise<PurchaseOrderSearchResult>;
  findAdjacent(id: number, direction: PurchaseOrderNavigationDirection): Promise<PurchaseOrder | null>;
  getPanel(id: number, key: PurchaseOrderPanelKey): Promise<PurchaseOrderPanelResult | null>;
  getClassifications(id: number): Promise<PurchaseOrderClassificationPanel | null>;
  saveClassifications(order: PurchaseOrderIdentity, update: PurchaseOrderClassificationUpdate): Promise<SavedPurchaseOrderClassifications>;
}
