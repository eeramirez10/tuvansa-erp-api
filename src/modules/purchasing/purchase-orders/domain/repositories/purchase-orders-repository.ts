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

export type PurchaseOrderPanelKey = 'receipts' | 'classifications' | 'comments';

export interface PurchaseOrderPanelResult {
  purchaseOrder: { id: number; number: string };
  key: PurchaseOrderPanelKey;
  section: 'actions';
  button: string;
  source: 'mysql';
  items: Array<Record<string, unknown>>;
  summary?: Record<string, unknown>;
}

export interface PurchaseOrdersRepository {
  findById(id: number): Promise<PurchaseOrder | null>;
  findByNumber(number: string): Promise<PurchaseOrder | null>;
  search(criteria: PurchaseOrderSearchCriteria): Promise<PurchaseOrderSearchResult>;
  findAdjacent(id: number, direction: PurchaseOrderNavigationDirection): Promise<PurchaseOrder | null>;
  getPanel(id: number, key: PurchaseOrderPanelKey): Promise<PurchaseOrderPanelResult | null>;
}
