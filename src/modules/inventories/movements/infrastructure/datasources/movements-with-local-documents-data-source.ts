import { ConflictError } from '../../../../../shared/domain/errors/conflict-error.js';
import { isLocalPurchaseReceptionId, readLocalPurchaseReceptions } from '../../../../purchasing/purchase-receptions/infrastructure/datasources/postgres-purchase-reception-writes.js';
import { isLocalPurchaseReceptionCancellationId, purchaseReceptionCancellationsAvailable } from '../../../../purchasing/purchase-receptions/infrastructure/datasources/purchase-posting-reversal-tables.js';
import { isLocalSalesRemissionId, readSalesRemissions } from '../../../../sales/invoicing/infrastructure/datasources/postgres-sales-remissions.js';
import { isLocalSalesRemissionCancellationId, salesRemissionCancellationsAvailable } from '../../../../sales/invoicing/infrastructure/datasources/sales-remission-cancellation-reads.js';
import type { PostgresClient } from '../../../../../shared/infrastructure/database/postgres-pool.js';
import type { MovementCancellationDataSource, MovementsDataSource } from '../../domain/datasources/movements-data-source.js';
import type { MovementDocument, MovementHeader } from '../../domain/entities/inventory-movement.js';
import type { MovementSearchCriteria, MovementSearchResult } from '../../domain/repositories/movements-repository.js';
import { isLocalInventoryAdjustmentId, readLocalInventoryAdjustments } from './postgres-inventory-adjustments.js';

const searchLimit = 1000;
const linkedReceipt = 'El movimiento está ligado a una recepción de compra.';
const linkedRemission = 'El movimiento está ligado a una remisión de venta.';
const unavailable = 'La cancelación requiere una copia conciliada de movimientos en PostgreSQL.';

const empty = { items: [], total: 0 } satisfies MovementSearchResult;
type LocalMovementTable = 'purchase_receptions' | 'sales_remissions' | 'purchase_reception_cancellations' | 'sales_remission_cancellations' | 'inventory_adjustments';
function readTable<T>(table: LocalMovementTable, fallback: T, read: (client: PostgresClient) => Promise<T>) {
  if (table === 'sales_remissions') return readSalesRemissions(fallback, read);
  if (table === 'sales_remission_cancellations') return readSalesRemissions(fallback, async (client) =>
    await salesRemissionCancellationsAvailable(client) ? read(client) : fallback);
  if (table === 'inventory_adjustments') return readLocalInventoryAdjustments(fallback, read);
  return readLocalPurchaseReceptions(fallback, async (client) => table === 'purchase_receptions' || await purchaseReceptionCancellationsAvailable(client)
    ? read(client) : fallback);
}

export class MovementsWithLocalDocumentsDataSource implements MovementsDataSource, MovementCancellationDataSource {
  constructor(
    private readonly base: MovementsDataSource,
    private readonly cancellations?: MovementCancellationDataSource,
    private readonly adjustments?: MovementCancellationDataSource,
  ) {}

  async search(criteria: MovementSearchCriteria): Promise<MovementSearchResult> {
    const filters = [
      ['document', criteria.document], ['reference', criteria.reference], ['reference2', criteria.reference2],
      ['warehouse', criteria.warehouse], ['supplierCode', criteria.supplier], ['customerCode', criteria.customer],
    ] as const;
    const conditions = ["movement #>> '{header,inventoryFlag}' = '1'"];
    const values: (string | number)[] = [];
    for (const [field, value] of filters) {
      if (value === undefined) continue;
      values.push(value.replace(/[!%_]/g, '!$&') + '%');
      const match = `movement #>> '{header,${field}}' ILIKE $${values.length} ESCAPE '!'`;
      conditions.push(field === 'warehouse' ? `(${match} OR (movement #>> '{header,type}'='TR'
        AND movement #>> '{header,reference2}' ILIKE $${values.length} ESCAPE '!'))` : match);
    }
    if (criteria.date !== undefined) {
      values.push(criteria.date);
      conditions.push(`movement #>> '{header,date}' = $${values.length}`);
    }
    if (values.length === 0) return this.base.search(criteria);

    const sortFields = [
      ['date', criteria.date], ['reference', criteria.reference], ['reference2', criteria.reference2],
      ['supplierCode', criteria.supplier], ['customerCode', criteria.customer],
    ] as const;
    const sort = sortFields.find(([, filter]) => filter !== undefined)?.[0] ?? 'document';
    const prefix = Math.min(searchLimit, criteria.offset + criteria.limit);
    values.push(prefix);
    const searchTable = (table: LocalMovementTable) => readTable<MovementSearchResult>(table, empty, async (client) => {
      const { rows: [row] } = await client.query<{ items: MovementHeader[]; total: string }>(
        `WITH matched AS (
           SELECT id, movement->'header' AS header FROM tuvansa.${table}
           WHERE ${conditions.join(' AND ')}
           ORDER BY lower(movement #>> '{header,${sort}}'), id LIMIT ${searchLimit}
         )
         SELECT (SELECT count(*) FROM matched)::text AS total,
           ARRAY(SELECT header FROM matched ORDER BY lower(header->>'${sort}'),id LIMIT $${values.length}) AS items`, values,
      );
      return { items: row?.items ?? [], total: Number(row?.total ?? 0) };
    });
    const local = await Promise.all([
      searchTable('purchase_receptions'), searchTable('sales_remissions'),
      searchTable('purchase_reception_cancellations'), searchTable('sales_remission_cancellations'), searchTable('inventory_adjustments'),
    ]);
    const total = local.reduce((count, source) => count + source.total, 0);
    if (total === 0) return this.base.search(criteria);

    const base = await this.base.search({ ...criteria, offset: 0, limit: prefix });
    const items = [...base.items, ...local.flatMap((source) => source.items)].sort((left, right) => {
      const a = left[sort].toLowerCase();
      const b = right[sort].toLowerCase();
      return a < b ? -1 : a > b ? 1 : left.id - right.id;
    });
    return {
      items: items.slice(criteria.offset, prefix),
      total: Math.min(searchLimit, total + base.total),
    };
  }

  findById(id: number): Promise<MovementDocument | null> {
    const table = isLocalPurchaseReceptionId(id) ? 'purchase_receptions' : isLocalSalesRemissionId(id) ? 'sales_remissions'
      : isLocalPurchaseReceptionCancellationId(id) ? 'purchase_reception_cancellations'
        : isLocalSalesRemissionCancellationId(id) ? 'sales_remission_cancellations'
          : isLocalInventoryAdjustmentId(id) ? 'inventory_adjustments' : null;
    if (!table) return this.base.findById(id);
    return readTable<MovementDocument | null>(table, null, async (client) => {
      const { rows: [row] } = await client.query<{ movement: MovementDocument }>(
        `SELECT movement FROM tuvansa.${table} WHERE id = $1`, [id],
      );
      return row?.movement ?? null;
    });
  }

  async canCancel(document: MovementDocument): Promise<string | null> {
    if (isLocalPurchaseReceptionId(document.header.id) || isLocalPurchaseReceptionCancellationId(document.header.id)) return linkedReceipt;
    if (isLocalSalesRemissionId(document.header.id) || isLocalSalesRemissionCancellationId(document.header.id)) return linkedRemission;
    if (isLocalInventoryAdjustmentId(document.header.id)) return this.adjustments ? this.adjustments.canCancel(document) : unavailable;
    return this.cancellations ? this.cancellations.canCancel(document) : unavailable;
  }

  async cancel(id: number): Promise<void> {
    if (isLocalPurchaseReceptionId(id) || isLocalPurchaseReceptionCancellationId(id)) throw new ConflictError(linkedReceipt, 'PURCHASE_RECEPTION_MOVEMENT_LINKED');
    if (isLocalSalesRemissionId(id) || isLocalSalesRemissionCancellationId(id)) throw new ConflictError(linkedRemission, 'SALES_REMISSION_MOVEMENT_LINKED');
    const cancellations = isLocalInventoryAdjustmentId(id) ? this.adjustments : this.cancellations;
    if (!cancellations) throw new ConflictError(unavailable, 'INVENTORY_MOVEMENT_CANCELLATION_UNAVAILABLE');
    await cancellations.cancel(id);
  }
}
