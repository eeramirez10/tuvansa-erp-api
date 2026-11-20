import type { PurchaseOrder } from '../entities/purchase-order.js';
import type { PurchaseOrderEditSnapshot } from './purchase-order-edit-data-source.js';
import type {
  PurchaseOrderNavigationDirection,
  PurchaseOrderPanelKey,
  PurchaseOrderPanelResult,
  PurchaseOrderSearchCriteria,
  PurchaseOrderSearchResult,
  PurchaseOrderClassificationPanel,
  PurchaseOrderClassificationUpdate,
  PurchaseOrderIdentity,
  SavedPurchaseOrderClassifications,
} from '../repositories/purchase-orders-repository.js';

export interface PurchaseOrdersDataSource {
  findById(id: number): Promise<PurchaseOrder | null>;
  findByNumber(number: string): Promise<PurchaseOrder | null>;
  search(criteria: PurchaseOrderSearchCriteria): Promise<PurchaseOrderSearchResult>;
  findAdjacent(id: number, direction: PurchaseOrderNavigationDirection): Promise<PurchaseOrder | null>;
  getPanel(id: number, key: PurchaseOrderPanelKey): Promise<PurchaseOrderPanelResult | null>;
  getClassifications(id: number): Promise<PurchaseOrderClassificationPanel | null>;
  saveClassifications(order: PurchaseOrderIdentity, update: PurchaseOrderClassificationUpdate): Promise<SavedPurchaseOrderClassifications>;
}

export interface LegacyPurchaseOrdersDataSource extends Omit<PurchaseOrdersDataSource, 'getPanel' | 'search' | 'saveClassifications'> {
  search(criteria: PurchaseOrderSearchCriteria, agents?: PurchaseOrderAgentOverride[]): Promise<PurchaseOrderSearchResult>;
  getPanel(id: number, key: Exclude<PurchaseOrderPanelKey, 'classifications'>, edits?: PurchaseOrderEditSnapshot[]): Promise<PurchaseOrderPanelResult | null>;
}

export type PurchaseOrderAgentOverride = PurchaseOrderIdentity & { matches: boolean };

export interface PurchaseOrderClassificationStorage {
  writable(): boolean;
  find(ids: number[]): Promise<SavedPurchaseOrderClassifications[]>;
  agentOverrides(prefix: string): Promise<PurchaseOrderAgentOverride[]>;
  save(order: PurchaseOrderIdentity, update: PurchaseOrderClassificationUpdate): Promise<SavedPurchaseOrderClassifications>;
}
