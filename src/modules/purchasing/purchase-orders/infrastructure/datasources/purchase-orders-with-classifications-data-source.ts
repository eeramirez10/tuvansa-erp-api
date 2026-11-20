import type { LegacyPurchaseOrdersDataSource, PurchaseOrderClassificationStorage, PurchaseOrdersDataSource } from '../../domain/datasources/purchase-orders-data-source.js';
import type { PurchaseOrder } from '../../domain/entities/purchase-order.js';
import type {
  PurchaseOrderNavigationDirection,
  PurchaseOrderClassificationPanel,
  PurchaseOrderClassificationUpdate,
  PurchaseOrderIdentity,
  SavedPurchaseOrderClassifications,
  PurchaseOrderPanelKey,
  PurchaseOrderPanelResult,
  PurchaseOrderSearchCriteria,
  PurchaseOrderSearchResult,
} from '../../domain/repositories/purchase-orders-repository.js';

export class PurchaseOrdersWithClassificationsDataSource implements PurchaseOrdersDataSource {
  constructor(
    private readonly dataSource: LegacyPurchaseOrdersDataSource,
    private readonly classificationStorage: PurchaseOrderClassificationStorage,
  ) {}

  private async classifiedOrders(items: PurchaseOrder[]): Promise<PurchaseOrder[]> {
    const identities = items.map((order) => order.identity);
    const stored = await this.classificationStorage.find(identities.map((order) => order.id));
    const byOrder = new Map(stored.map((record) => [`${record.id}/${record.number}`, record.current]));
    return items.map((order) => {
      const { id, number } = order.identity;
      const current = byOrder.get(`${id}/${number}`);
      return current ? order.withClassifications(current) : order;
    });
  }

  private async classifiedOrder(order: Promise<PurchaseOrder | null>): Promise<PurchaseOrder | null> {
    const found = await order;
    return found ? (await this.classifiedOrders([found]))[0] ?? null : null;
  }

  findById(id: number): Promise<PurchaseOrder | null> { return this.classifiedOrder(this.dataSource.findById(id)); }
  findByNumber(number: string): Promise<PurchaseOrder | null> { return this.classifiedOrder(this.dataSource.findByNumber(number)); }
  async search(criteria: PurchaseOrderSearchCriteria): Promise<PurchaseOrderSearchResult> {
    const agents = criteria.agent === undefined ? undefined : await this.classificationStorage.agentOverrides(criteria.agent);
    const result = await this.dataSource.search(criteria, agents);
    return { ...result, items: await this.classifiedOrders(result.items) };
  }
  findAdjacent(id: number, direction: PurchaseOrderNavigationDirection): Promise<PurchaseOrder | null> {
    return this.classifiedOrder(this.dataSource.findAdjacent(id, direction));
  }
  getPanel(id: number, key: PurchaseOrderPanelKey): Promise<PurchaseOrderPanelResult | null> {
    return key === 'classifications' ? this.getClassifications(id) : this.dataSource.getPanel(id, key);
  }

  async getClassifications(id: number): Promise<PurchaseOrderClassificationPanel | null> {
    const panel = await this.dataSource.getClassifications(id);
    if (!panel) return null;
    const stored = (await this.classificationStorage.find([id])).find((row) => row.number === panel.purchaseOrder.number);
    return {
      ...panel,
      source: stored ? 'mysql+postgres' : panel.source,
      summary: {
        ...panel.summary,
        current: stored?.current ?? panel.summary.current,
        revision: stored?.revision ?? 0,
        canWrite: this.classificationStorage.writable(),
      },
    };
  }

  saveClassifications(order: PurchaseOrderIdentity, update: PurchaseOrderClassificationUpdate): Promise<SavedPurchaseOrderClassifications> {
    return this.classificationStorage.save(order, update);
  }
}
