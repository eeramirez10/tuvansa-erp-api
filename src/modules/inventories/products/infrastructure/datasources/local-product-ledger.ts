import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import { connectPostgres, postgresConfigured, type PostgresClient } from '../../../../../shared/infrastructure/database/postgres-pool.js';
import { hasLocalSalesStock } from '../../../../sales/orders/infrastructure/datasources/sales-order-inventory-stock.js';
import type { MovementHeader, MovementLine } from '../../../movements/domain/entities/inventory-movement.js';
import type { ProductLedgerFilters } from '../../domain/repositories/product-panels-repository.js';

const sources = [
  { flag: 'receipts', table: 'purchase_receptions', stock: 'purchase_reception_inventory', key: 'receipt_id' },
  { flag: 'receiptCancellations', table: 'purchase_reception_cancellations', stock: 'purchase_reception_cancellation_inventory', key: 'cancellation_id' },
  { flag: 'remissions', table: 'sales_remissions', stock: 'sales_remission_inventory', key: 'remittance_id' },
  { flag: 'remissionCancellations', table: 'sales_remission_cancellations', stock: 'sales_remission_cancellation_inventory', key: 'cancellation_id' },
  { flag: 'adjustments', table: 'inventory_adjustments', stock: 'inventory_adjustment_stock', key: 'adjustment_id' },
] as const;

interface LocalLedgerPage {
  items: Record<string, unknown>[];
  openingDelta: number;
}

const empty: LocalLedgerPage = { items: [], openingDelta: 0 };

export async function localProductLedger(
  productId: number,
  filters: ProductLedgerFilters | undefined,
  limit: number,
  findOffset: () => Promise<number>,
): Promise<LocalLedgerPage> {
  const { warehouse, movementType, openingMovementType } = filters ?? {};
  const recalculateOpening = warehouse !== undefined && openingMovementType !== undefined;
  if (!postgresConfigured() || (limit <= 0 && !recalculateOpening)) return empty;

  let client: PostgresClient | undefined;
  try {
    client = await connectPostgres();
    const tables = await hasLocalSalesStock(client);
    const queries = sources.filter(({ flag }) => tables[flag]).map(({ table, stock, key }) =>
      `SELECT d.movement->'header' AS header, part AS line
       FROM tuvansa.${table} d
       CROSS JOIN LATERAL jsonb_array_elements(d.movement->'lines') AS part
       WHERE d.movement #>> '{header,company}'='1'
         AND (part->>'productId')::bigint=$1
         AND EXISTS (SELECT 1 FROM tuvansa.${stock} i WHERE i.product_id=$1 AND i.${key}=d.id)`,
    );
    if (queries.length === 0) return empty;
    const source = `(${queries.join(' UNION ALL ')}) AS movements`;
    const { rows } = limit > 0 ? await client.query<{ header: MovementHeader; line: MovementLine }>(
      `SELECT header,line FROM ${source}
       WHERE ($2::text IS NULL OR line->>'warehouse'=$2) AND ($3::text IS NULL OR line->>'type'=$3)
       ORDER BY (line->>'id')::bigint LIMIT $4 OFFSET $5`,
      [productId, warehouse ?? null, movementType ?? null, limit, await findOffset()],
    ) : { rows: [] };
    const { rows: [opening] } = recalculateOpening ? await client.query<{ delta: number }>(
      `SELECT COALESCE(SUM((line->>'quantity')::numeric),0)::float8 AS delta
       FROM ${source} WHERE line->>'warehouse'=$2 AND line->>'type'<>$3`,
      [productId, warehouse, openingMovementType],
    ) : { rows: [] };
    return {
      items: rows.map(({ header, line }) => ({
        id: line.id, date: header.date, document: header.document, quantity: line.quantity, cost: line.cost,
        movementType: line.type, warehouse: line.warehouse, lotId: line.lotId, route: 0, userId: line.userId,
        revaluation: 0, documentUserId: header.userId, documentId: header.id, customsEntry: '', reference: header.reference,
        pieces: line.piecesText, sku: '', ellosReference: header.reference2,
      })),
      openingDelta: opening?.delta ?? 0,
    };
  } catch (error) {
    if (error instanceof ApplicationError) throw error;
    throw new ApplicationError('No fue posible consultar los movimientos locales del auxiliar.', 'INVENTORY_LEDGER_POSTGRES_UNAVAILABLE', 503);
  } finally { client?.release(); }
}
