import { ConflictError } from '../../../../../shared/domain/errors/conflict-error.js';
import { isLocalPurchaseReceptionId, readLocalPurchaseReceptions } from '../../../../purchasing/purchase-receptions/infrastructure/datasources/postgres-purchase-reception-writes.js';
import type { MovementCancellationDataSource, MovementsDataSource } from '../../domain/datasources/movements-data-source.js';
import type { MovementDocument, MovementHeader } from '../../domain/entities/inventory-movement.js';
import type { MovementSearchCriteria, MovementSearchResult } from '../../domain/repositories/movements-repository.js';

const searchLimit = 1000;
const linkedReceipt = 'El movimiento está ligado a una recepción de compra.';
const unavailable = 'La cancelación requiere una copia conciliada de movimientos en PostgreSQL.';

export class MovementsWithPurchaseReceptionsDataSource implements MovementsDataSource, MovementCancellationDataSource {
  constructor(
    private readonly base: MovementsDataSource,
    private readonly cancellations?: MovementCancellationDataSource,
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
      conditions.push(`movement #>> '{header,${field}}' ILIKE $${values.length} ESCAPE '!'`);
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
    const local = await readLocalPurchaseReceptions({ items: [], total: 0 } as MovementSearchResult, async (client) => {
      // Derivada. Extrae encabezados de las recepciones web.
      const { rows: [row] } = await client.query<{ items: MovementHeader[]; total: string }>(
        `WITH matched AS (
           SELECT id, movement->'header' AS header FROM tuvansa.purchase_receptions
           WHERE ${conditions.join(' AND ')}
           ORDER BY lower(movement #>> '{header,${sort}}'), id LIMIT $${values.length}
         )
         SELECT count(*)::text AS total,
           coalesce(array_agg(header ORDER BY lower(header->>'${sort}'), id), '{}') AS items
         FROM matched`, values,
      );
      return { items: row?.items ?? [], total: Number(row?.total ?? 0) };
    });
    if (local.total === 0) return this.base.search(criteria);

    const base = await this.base.search({ ...criteria, offset: 0, limit: prefix });
    const items = [...base.items, ...local.items].sort((left, right) => {
      const a = left[sort].toLowerCase();
      const b = right[sort].toLowerCase();
      return a < b ? -1 : a > b ? 1 : left.id - right.id;
    });
    return {
      items: items.slice(criteria.offset, prefix),
      total: Math.min(searchLimit, local.total + base.total),
    };
  }

  findById(id: number): Promise<MovementDocument | null> {
    if (!isLocalPurchaseReceptionId(id)) return this.base.findById(id);
    return readLocalPurchaseReceptions(null as MovementDocument | null, async (client) => {
      const { rows: [row] } = await client.query<{ movement: MovementDocument }>(
        'SELECT movement FROM tuvansa.purchase_receptions WHERE id = $1', [id],
      );
      return row?.movement ?? null;
    });
  }

  async canCancel(document: MovementDocument): Promise<string | null> {
    if (isLocalPurchaseReceptionId(document.header.id)) return linkedReceipt;
    return this.cancellations ? this.cancellations.canCancel(document) : unavailable;
  }

  async cancel(id: number): Promise<void> {
    if (isLocalPurchaseReceptionId(id)) throw new ConflictError(linkedReceipt, 'PURCHASE_RECEPTION_MOVEMENT_LINKED');
    if (!this.cancellations) throw new ConflictError(unavailable, 'INVENTORY_MOVEMENT_CANCELLATION_UNAVAILABLE');
    await this.cancellations.cancel(id);
  }
}
