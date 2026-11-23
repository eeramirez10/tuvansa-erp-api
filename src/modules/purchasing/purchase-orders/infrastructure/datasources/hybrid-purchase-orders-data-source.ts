import type { LegacyPurchaseOrdersDataSource, PurchaseOrderClassificationStorage, PurchaseOrdersDataSource } from '../../domain/datasources/purchase-orders-data-source.js';
import type { PurchaseOrderEditStorage } from '../../domain/datasources/purchase-order-edit-data-source.js';
import type { PurchaseOrderAuthorizationStorage } from '../../domain/datasources/purchase-order-authorization-data-source.js';
import type { PurchaseOrderConversionStorage } from '../../domain/datasources/purchase-order-conversion-data-source.js';
import type { PurchaseOrderSupplierChangeStorage } from '../../domain/datasources/purchase-order-supplier-change-data-source.js';
import { isLocalPurchaseOrderId, type PurchaseOrderCreateStorage } from '../../domain/datasources/purchase-order-create-data-source.js';
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

const sortOrders = (a: PurchaseOrder, b: PurchaseOrder) =>
  a.identity.number.localeCompare(b.identity.number, 'en', { sensitivity: 'base' }) || a.identity.id - b.identity.id;
const normalizeSearch = (value: string) => value.normalize('NFD').replace(/\p{M}/gu, '').toUpperCase();
const authorizationDate = new Intl.DateTimeFormat('es-MX', { dateStyle: 'short', timeZone: 'America/Mexico_City' });
const authorizationDateTime = new Intl.DateTimeFormat('sv-SE', {
  dateStyle: 'short', timeStyle: 'medium', timeZone: 'America/Mexico_City',
});

export class HybridPurchaseOrdersDataSource implements PurchaseOrdersDataSource {
  constructor(
    private readonly dataSource: LegacyPurchaseOrdersDataSource,
    private readonly classificationStorage: PurchaseOrderClassificationStorage,
    private readonly editStorage: PurchaseOrderEditStorage & Pick<PurchaseOrderAuthorizationStorage, 'findAuthorizationEvents'> &
      Pick<PurchaseOrderSupplierChangeStorage, 'findSupplierChanges'> & Pick<PurchaseOrderConversionStorage, 'findKindOverrides'>,
    private readonly creation: PurchaseOrderCreateStorage,
  ) {}

  private async withChanges(items: PurchaseOrder[], includeLines = true): Promise<PurchaseOrder[]> {
    const ids = items.map((order) => order.identity.id);
    const [stored, edited, supplierChanges] = await Promise.all([
      this.classificationStorage.find(ids), this.editStorage.find(ids),
      this.editStorage.findSupplierChanges(ids.filter((id) => !isLocalPurchaseOrderId(id))),
    ]);
    const byOrder = new Map(stored.map((record) => [`${record.id}/${record.number}`, record.current]));
    const edits = new Map(edited.map((record) => [`${record.id}/${record.number}`, record]));
    const suppliers = new Map(supplierChanges.map((change) => [`${change.id}/${change.number}`, change]));
    return items.map((order) => {
      const { id, number } = order.identity;
      const key = `${id}/${number}`;
      const current = byOrder.get(key);
      const edit = edits.get(key);
      const change = suppliers.get(key);
      const withSupplier = change ? order.withSupplier(change.supplier, change.supplierParameter) : order;
      const classified = current ? withSupplier.withClassifications(current) : withSupplier;
      return edit ? classified.withEditedLines(edit, includeLines) : classified;
    });
  }

  private async classifiedOrder(order: Promise<PurchaseOrder | null>): Promise<PurchaseOrder | null> {
    const found = await order;
    return found ? (await this.withChanges([found]))[0] ?? null : null;
  }

  private async orderById(id: number): Promise<PurchaseOrder | null> {
    const [local, removed] = await Promise.all([this.creation.findLocal(id), this.editStorage.findRemoved([id])]);
    const order = local?.order ?? await this.dataSource.findById(id);
    return order && !removed.some(({ number }) => number === order.identity.number) ? order : null;
  }

  findById(id: number): Promise<PurchaseOrder | null> { return this.classifiedOrder(this.orderById(id)); }
  async findByNumber(number: string): Promise<PurchaseOrder | null> {
    const [local, removed] = await Promise.all([this.creation.findLocalByNumber(number), this.editStorage.findRemoved()]);
    if (local && !removed.some(({ id, number }) => id === local.order.identity.id && number === local.order.identity.number)) {
      return this.classifiedOrder(Promise.resolve(local.order));
    }
    return this.classifiedOrder(this.dataSource.findByNumber(number, removed));
  }

  async search(criteria: PurchaseOrderSearchCriteria): Promise<PurchaseOrderSearchResult> {
    const [agents, removed, supplierChanges, kinds] = await Promise.all([
      criteria.agent === undefined ? undefined : this.classificationStorage.agentOverrides(criteria.agent),
      this.editStorage.findRemoved(),
      criteria.query === undefined && criteria.supplierCode === undefined ? [] : this.editStorage.findSupplierChanges(),
      criteria.documentType === undefined ? [] : this.editStorage.findKindOverrides(),
    ]);
    const query = normalizeSearch(criteria.query ?? '');
    const code = normalizeSearch(criteria.supplierCode ?? '');
    const supplierFilters = supplierChanges.filter(({ id }) => !isLocalPurchaseOrderId(id)).map(({ id, number, supplier }) => ({
      id, number,
      queryMatches: normalizeSearch(supplier.code).includes(query) || normalizeSearch(supplier.name).includes(query),
      codeMatches: normalizeSearch(supplier.code).startsWith(code),
    }));
    const legacyKinds = kinds.filter(({ id }) => !isLocalPurchaseOrderId(id));
    const local = await this.creation.searchLocal(criteria,
      agents?.filter((order) => !order.matches) ?? [], agents?.filter((order) => order.matches) ?? [], removed);
    if (local.total === 0) {
      const result = await this.dataSource.search(criteria, agents, removed, supplierFilters, legacyKinds);
      return { ...result, items: await this.withChanges(result.items, false) };
    }
    const legacyOffset = Math.max(0, criteria.offset - local.total);
    const offset = criteria.offset - legacyOffset;
    const legacy = await this.dataSource.search({ ...criteria, offset: legacyOffset, limit: offset + criteria.limit },
      agents, removed, supplierFilters, legacyKinds);
    const items = [...legacy.items, ...local.items].sort(sortOrders).slice(offset, offset + criteria.limit);
    return { items: await this.withChanges(items, false), total: legacy.total + local.total };
  }

  async findAdjacent(id: number, direction: PurchaseOrderNavigationDirection): Promise<PurchaseOrder | null> {
    const [localOrder, removed] = await Promise.all([this.creation.findLocal(id), this.editStorage.findRemoved()]);
    const current = localOrder?.order.identity ?? await this.dataSource.findIdentity(id) ?? removed.find((row) => row.id === id);
    if (!current) return null;
    const { number } = current;
    const [local, legacy] = await Promise.all([
      this.creation.findLocalAdjacent(number, direction, removed), this.dataSource.findAdjacentByNumber(number, direction, removed),
    ]);
    const closest = local && legacy
      ? (direction === 'previous' ? sortOrders(local, legacy) > 0 : sortOrders(local, legacy) < 0) ? local : legacy
      : local ?? legacy;
    return this.classifiedOrder(Promise.resolve(closest));
  }

  async getPanel(id: number, key: PurchaseOrderPanelKey): Promise<PurchaseOrderPanelResult | null> {
    if (key === 'classifications') return this.getClassifications(id);
    const local = await this.creation.findLocal(id);
    if (await this.isRemoved(id, local?.order.identity)) return null;
    if (local) {
      const { order, metadata } = local;
      if (key === 'receipts' || key === 'pieces') {
        return this.dataSource.getPanel(id, key, undefined, order.identity);
      }
      const edits = await this.editStorage.find([id]);
      if (key === 'ct') {
        const panel = await this.dataSource.getPanel(id, key, edits, order.identity);
        return panel && { ...panel, source: 'mysql+postgres' };
      }
      const edit = edits[0];
      return this.withAuthorizationComments({
        purchaseOrder: order.identity, key, section: 'actions', button: 'Comentarios', source: 'postgres',
        items: [{ amountInWords: edit?.amountInWords ?? '' }],
        summary: {
          ...order.toPrimitives(), totals: edit?.totals, lines: edit?.lines,
          terms: metadata.terms, currencyId: metadata.rules.currencyId, currencyName: metadata.rules.currencyName,
          exchangeRate: metadata.exchangeRate, onAccount: metadata.onAccount, labels: metadata.labels, createdAt: metadata.createdAt,
        },
      });
    }
    if (key !== 'comments' && key !== 'ct') return this.dataSource.getPanel(id, key);
    const edits = await this.editStorage.find([id]);
    const panel = await this.dataSource.getPanel(id, key, key === 'ct' ? edits : undefined);
    if (!panel) return null;
    const edit = edits.find((item) => item.number === panel.purchaseOrder.number);
    if (key === 'ct') return edit ? { ...panel, source: 'mysql+postgres' } : panel;
    if (!edit) return this.withAuthorizationComments(panel);
    const items = [...panel.items];
    if (typeof edit.amountInWords === 'string') items[0] = { ...items[0], amountInWords: edit.amountInWords };
    return this.withAuthorizationComments({
      ...panel, source: 'mysql+postgres', items, summary: { ...panel.summary, totals: edit.totals, lines: edit.lines },
    });
  }

  private async withAuthorizationComments(panel: PurchaseOrderPanelResult): Promise<PurchaseOrderPanelResult> {
    const [events, changes] = await Promise.all([
      this.editStorage.findAuthorizationEvents(panel.purchaseOrder),
      this.editStorage.findSupplierChanges([panel.purchaseOrder.id]),
    ]);
    const change = changes.find(({ number }) => number === panel.purchaseOrder.number);
    if (events.length === 0 && !change) return panel;
    const items = [...panel.items];
    const initialLine = String(items[0]?.line4 ?? '');
    const notes = events.map(({ level, direction, actorId, occurredAt }) =>
      `, ${direction === 'revoke' ? '-' : ''}${level} usr:${actorId} ${authorizationDate.format(new Date(occurredAt))}`);
    if (notes.length > 0) items[0] = { ...items[0], line4: initialLine + notes.join('') };
    const summary = { ...panel.summary };
    if (change) {
      summary.supplier = change.supplier;
      if (change.supplierParameter !== null) summary.supplierParameter = change.supplierParameter;
    }
    const levelD = events.findLast(({ level }) => level === 'D');
    if (levelD) summary.authorizedBy = levelD.direction === 'approve' ? levelD.actorId : 0;
    const levelC = events.findLast(({ level, direction }) => level === 'C' && direction === 'approve');
    if (levelC) summary.modifiedAt = authorizationDateTime.format(new Date(levelC.occurredAt));
    return { ...panel, items, summary, source: panel.source === 'mysql' ? 'mysql+postgres' : panel.source };
  }

  async getClassifications(id: number): Promise<PurchaseOrderClassificationPanel | null> {
    const local = await this.creation.findLocal(id);
    if (await this.isRemoved(id, local?.order.identity)) return null;
    const panel = await this.dataSource.getClassifications(id, local?.order);
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

  private async isRemoved(id: number, local?: PurchaseOrderIdentity): Promise<boolean> {
    const removed = await this.editStorage.findRemoved([id]);
    if (removed.length === 0) return false;
    const current = local ?? await this.dataSource.findIdentity(id);
    return !current || removed.some(({ number }) => number === current.number);
  }
}
