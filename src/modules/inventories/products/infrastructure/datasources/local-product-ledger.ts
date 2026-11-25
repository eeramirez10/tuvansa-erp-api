import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import { connectPostgres, postgresConfigured, type PostgresClient } from '../../../../../shared/infrastructure/database/postgres-pool.js';
import { hasLocalSalesStock } from '../../../../sales/orders/infrastructure/datasources/sales-order-inventory-stock.js';
import { salesTicketConversionSql } from '../../../../sales/invoicing/infrastructure/datasources/sales-ticket-conversion-reads.js';
import type { MovementHeader, MovementLine } from '../../../movements/domain/entities/inventory-movement.js';
import type { ProductLedgerFilters, ProductLotMovementTotals } from '../../domain/repositories/product-panels-repository.js';

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
  lotTotals?: ProductLotMovementTotals;
}

type LocalMovement = { header: MovementHeader; line: MovementLine };

const empty: LocalLedgerPage = { items: [], openingDelta: 0 };

async function localLotPage(
  client: PostgresClient, source: string, productId: number, filters: ProductLedgerFilters,
  limit: number, offset: number,
) {
  const { rows: [page] } = await client.query<ProductLotMovementTotals & { items: LocalMovement[] }>(
    `WITH matched AS (
       SELECT header,line FROM ${source}
       WHERE ($2::text IS NULL OR line->>'warehouse'=$2) AND ($3::text IS NULL OR line->>'type'=$3)
         AND line->>'lotId'=$4::text
     ), paged AS (
       SELECT header,line FROM matched ORDER BY (line->>'id')::bigint LIMIT $5 OFFSET $6
     )
     SELECT (SELECT COALESCE(jsonb_agg(to_jsonb(paged) ORDER BY (line->>'id')::bigint), '[]'::jsonb) FROM paged) AS items,
       COUNT(*)::float8 AS count, COALESCE(SUM(GREATEST((line->>'quantity')::numeric,0)),0)::float8 AS entries,
       COALESCE(SUM(GREATEST(-(line->>'quantity')::numeric,0)),0)::float8 AS exits,
       COALESCE(SUM((line->>'quantity')::numeric),0)::float8 AS net
     FROM matched`,
    [productId, filters.warehouse ?? null, filters.movementType ?? null, filters.lotId, limit, offset],
  );
  const { items, ...lotTotals } = page!;
  return { rows: items, lotTotals };
}

export async function localProductLedger(
  productId: number,
  filters: ProductLedgerFilters | undefined,
  limit: number,
  findOffset: () => Promise<number>,
): Promise<LocalLedgerPage> {
  const scope = filters ?? {};
  const { warehouse, movementType, openingMovementType, lotId } = scope;
  const recalculateOpening = warehouse !== undefined && openingMovementType !== undefined;
  if (!postgresConfigured() || (limit <= 0 && !recalculateOpening && lotId === undefined)) return empty;

  let client: PostgresClient | undefined;
  try {
    client = await connectPostgres();
    const tables = await hasLocalSalesStock(client);
    const conversion = tables.remissions ? await salesTicketConversionSql(client, 'd') : null;
    const queries = sources.filter(({ flag }) => tables[flag]).map(({ flag, table, stock, key }) => {
      const effective = flag === 'remissions' ? conversion : null;
      const baseHeader = "d.movement->'header'";
      const header = effective?.join ? `CASE WHEN ${effective.converted} THEN
        jsonb_set(${baseHeader},'{document}',to_jsonb(${effective.number})) ELSE ${baseHeader} END` : baseHeader;
      return `SELECT ${header} AS header, part AS line
        FROM tuvansa.${table} d ${effective?.join ?? ''}
        CROSS JOIN LATERAL jsonb_array_elements(d.movement->'lines') AS part
        WHERE d.movement #>> '{header,company}'='1'
          AND (part->>'productId')::bigint=$1
          AND EXISTS (SELECT 1 FROM tuvansa.${stock} i WHERE i.product_id=$1 AND i.${key}=d.id)`;
    });
    if (queries.length === 0) return empty;
    const source = `(${queries.join(' UNION ALL ')}) AS movements`;
    const offset = limit > 0 ? await findOffset() : 0;
    const lotPage = lotId === undefined ? undefined : await localLotPage(client, source, productId, scope, limit, offset);
    const rows = lotPage?.rows ?? (limit > 0 ? (await client.query<LocalMovement>(
      `SELECT header,line FROM ${source}
       WHERE ($2::text IS NULL OR line->>'warehouse'=$2) AND ($3::text IS NULL OR line->>'type'=$3)
       ORDER BY (line->>'id')::bigint LIMIT $4 OFFSET $5`,
      [productId, warehouse ?? null, movementType ?? null, limit, offset],
    )).rows : []);
    const { rows: [opening] } = recalculateOpening ? await client.query<{ delta: number }>(
      `SELECT COALESCE(SUM((line->>'quantity')::numeric),0)::float8 AS delta
       FROM ${source} WHERE line->>'warehouse'=$2 AND line->>'type'<>$3`,
      [productId, warehouse, openingMovementType],
    ) : { rows: [] };
    return {
      items: rows.map(({ header, line }) => ({
        id: line.id, date: header.date, document: header.document, quantity: line.quantity, cost: line.cost,
        movementType: line.type, warehouse: line.warehouse, lotId: line.lotId, route: 0, userId: line.userId,
        revaluation: 0, documentUserId: header.userId, documentId: header.id, customsEntry: line.customsEntry ?? '', reference: header.reference,
        pieces: line.piecesText, sku: '', ellosReference: header.reference2,
      })),
      openingDelta: opening?.delta ?? 0,
      ...(lotPage === undefined ? {} : { lotTotals: lotPage.lotTotals }),
    };
  } catch (error) {
    if (error instanceof ApplicationError) throw error;
    throw new ApplicationError('No fue posible consultar los movimientos locales del auxiliar.', 'INVENTORY_LEDGER_POSTGRES_UNAVAILABLE', 503);
  } finally { client?.release(); }
}
