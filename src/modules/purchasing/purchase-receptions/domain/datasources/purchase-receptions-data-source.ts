import type { PurchaseReception } from '../entities/purchase-reception.js';
import type {
  PurchaseReceptionNavigationDirection,
  PurchaseReceptionPanelKey,
  PurchaseReceptionPanelResult,
  PurchaseReceptionSearchCriteria,
  PurchaseReceptionSearchResult,
} from '../repositories/purchase-receptions-repository.js';

export interface PurchaseReceptionsDataSource {
  findById(id: number): Promise<PurchaseReception | null>;
  findByNumber(number: string): Promise<PurchaseReception | null>;
  search(criteria: PurchaseReceptionSearchCriteria): Promise<PurchaseReceptionSearchResult>;
  findAdjacent(id: number, direction: PurchaseReceptionNavigationDirection): Promise<PurchaseReception | null>;
  getPanel(id: number, key: PurchaseReceptionPanelKey): Promise<PurchaseReceptionPanelResult | null>;
}
