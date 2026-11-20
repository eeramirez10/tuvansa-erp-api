import type { PurchaseOrdersDataSource } from '../../domain/datasources/purchase-orders-data-source.js';
import type { PurchaseOrder } from '../../domain/entities/purchase-order.js';
import type {
  PurchaseOrderClassificationPanel,
  PurchaseOrderClassificationUpdate,
  PurchaseOrderIdentity,
  PurchaseOrderNavigationDirection,
  PurchaseOrderPanelKey,
  PurchaseOrderPanelResult,
  PurchaseOrderSearchCriteria,
  PurchaseOrderSearchResult,
  PurchaseOrdersRepository,
  SavedPurchaseOrderClassifications,
} from '../../domain/repositories/purchase-orders-repository.js';

export class PurchaseOrdersRepositoryImpl implements PurchaseOrdersRepository {
  constructor(private readonly dataSource: PurchaseOrdersDataSource) {}

  findById(id: number): Promise<PurchaseOrder | null> { return this.dataSource.findById(id); }
  findByNumber(number: string): Promise<PurchaseOrder | null> { return this.dataSource.findByNumber(number); }
  search(criteria: PurchaseOrderSearchCriteria): Promise<PurchaseOrderSearchResult> { return this.dataSource.search(criteria); }
  findAdjacent(id: number, direction: PurchaseOrderNavigationDirection): Promise<PurchaseOrder | null> {
    return this.dataSource.findAdjacent(id, direction);
  }
  getPanel(id: number, key: PurchaseOrderPanelKey): Promise<PurchaseOrderPanelResult | null> {
    return this.dataSource.getPanel(id, key);
  }
  getClassifications(id: number): Promise<PurchaseOrderClassificationPanel | null> {
    return this.dataSource.getClassifications(id);
  }
  saveClassifications(order: PurchaseOrderIdentity, update: PurchaseOrderClassificationUpdate): Promise<SavedPurchaseOrderClassifications> {
    return this.dataSource.saveClassifications(order, update);
  }
}
