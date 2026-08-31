import type { PurchaseReception } from '../entities/purchase-reception.js';

export type PurchaseReceptionNavigationDirection = 'previous' | 'next';

export interface PurchaseReceptionSearchCriteria {
  query?: string;
  documentNumber?: string;
  receivedAt?: string;
  orderNumber?: string;
  supplierReference?: string;
  deliveryNote?: string;
  folio?: string;
  supplierCode?: string;
  warehouse?: string;
  offset: number;
  limit: number;
}

export interface PurchaseReceptionSearchResult {
  items: PurchaseReception[];
  total: number;
}

export type PurchaseReceptionPanelKey = 'auxiliary' | 'classifications';

export interface PurchaseReceptionPanelResult {
  purchaseReception: { id: number; number: string };
  key: PurchaseReceptionPanelKey;
  section: 'actions';
  button: string;
  source: 'mysql';
  items: Array<Record<string, unknown>>;
  summary?: Record<string, unknown>;
}

export interface PurchaseReceptionsRepository {
  findById(id: number): Promise<PurchaseReception | null>;
  findByNumber(number: string): Promise<PurchaseReception | null>;
  search(criteria: PurchaseReceptionSearchCriteria): Promise<PurchaseReceptionSearchResult>;
  findAdjacent(id: number, direction: PurchaseReceptionNavigationDirection): Promise<PurchaseReception | null>;
  getPanel(id: number, key: PurchaseReceptionPanelKey): Promise<PurchaseReceptionPanelResult | null>;
}
