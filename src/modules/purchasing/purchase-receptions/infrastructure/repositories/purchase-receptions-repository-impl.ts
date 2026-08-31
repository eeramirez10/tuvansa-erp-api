import type { PurchaseReceptionsDataSource } from '../../domain/datasources/purchase-receptions-data-source.js';
import type { PurchaseReception } from '../../domain/entities/purchase-reception.js';
import type {
  PurchaseReceptionNavigationDirection,
  PurchaseReceptionPanelKey,
  PurchaseReceptionPanelResult,
  PurchaseReceptionSearchCriteria,
  PurchaseReceptionSearchResult,
  PurchaseReceptionsRepository,
} from '../../domain/repositories/purchase-receptions-repository.js';

export class PurchaseReceptionsRepositoryImpl implements PurchaseReceptionsRepository {
  constructor(private readonly dataSource: PurchaseReceptionsDataSource) {}
  findById(id: number): Promise<PurchaseReception | null> { return this.dataSource.findById(id); }
  findByNumber(number: string): Promise<PurchaseReception | null> { return this.dataSource.findByNumber(number); }
  search(criteria: PurchaseReceptionSearchCriteria): Promise<PurchaseReceptionSearchResult> { return this.dataSource.search(criteria); }
  findAdjacent(id: number, direction: PurchaseReceptionNavigationDirection): Promise<PurchaseReception | null> { return this.dataSource.findAdjacent(id, direction); }
  getPanel(id: number, key: PurchaseReceptionPanelKey): Promise<PurchaseReceptionPanelResult | null> { return this.dataSource.getPanel(id, key); }
}
