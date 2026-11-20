import type { LegacyPurchaseOrdersDataSource, PurchaseOrderClassificationStorage, PurchaseOrdersDataSource } from '../../domain/datasources/purchase-orders-data-source.js';
import type { PurchaseOrderEditStorage } from '../../domain/datasources/purchase-order-edit-data-source.js';
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

export class HybridPurchaseOrdersDataSource implements PurchaseOrdersDataSource {
  constructor(
    private readonly dataSource: LegacyPurchaseOrdersDataSource,
    private readonly classificationStorage: PurchaseOrderClassificationStorage,
    private readonly editStorage: PurchaseOrderEditStorage,
  ) {}

  private async withChanges(items: PurchaseOrder[], includeLines = true): Promise<PurchaseOrder[]> {
    const ids = items.map((order) => order.identity.id);
    const [stored, edited] = await Promise.all([this.classificationStorage.find(ids), this.editStorage.find(ids)]);
    const byOrder = new Map(stored.map((record) => [`${record.id}/${record.number}`, record.current]));
    const edits = new Map(edited.map((record) => [`${record.id}/${record.number}`, record]));
    return items.map((order) => {
      const { id, number } = order.identity;
      const key = `${id}/${number}`;
      const current = byOrder.get(key);
      const edit = edits.get(key);
      const classified = current ? order.withClassifications(current) : order;
      return edit ? classified.withEditedLines(edit, includeLines) : classified;
    });
  }

  private async classifiedOrder(order: Promise<PurchaseOrder | null>): Promise<PurchaseOrder | null> {
    const found = await order;
    return found ? (await this.withChanges([found]))[0] ?? null : null;
  }

  findById(id: number): Promise<PurchaseOrder | null> { return this.classifiedOrder(this.dataSource.findById(id)); }
  findByNumber(number: string): Promise<PurchaseOrder | null> { return this.classifiedOrder(this.dataSource.findByNumber(number)); }
  async search(criteria: PurchaseOrderSearchCriteria): Promise<PurchaseOrderSearchResult> {
    const agents = criteria.agent === undefined ? undefined : await this.classificationStorage.agentOverrides(criteria.agent);
    const result = await this.dataSource.search(criteria, agents);
    return { ...result, items: await this.withChanges(result.items, false) };
  }
  findAdjacent(id: number, direction: PurchaseOrderNavigationDirection): Promise<PurchaseOrder | null> {
    return this.classifiedOrder(this.dataSource.findAdjacent(id, direction));
  }
  async getPanel(id: number, key: PurchaseOrderPanelKey): Promise<PurchaseOrderPanelResult | null> {
    if (key === 'classifications') return this.getClassifications(id);
    if (key !== 'comments' && key !== 'ct') return this.dataSource.getPanel(id, key);
    const edits = await this.editStorage.find([id]);
    const panel = await this.dataSource.getPanel(id, key, key === 'ct' ? edits : undefined);
    if (!panel) return null;
    const edit = edits.find((item) => item.number === panel.purchaseOrder.number);
    if (!edit) return panel;
    if (key === 'ct') return { ...panel, source: 'mysql+postgres' };
    const items = [...panel.items];
    items[0] = { ...items[0], amountInWords: edit.amountInWords };
    return { ...panel, source: 'mysql+postgres', items, summary: { ...panel.summary, totals: edit.totals, lines: edit.lines } };
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
