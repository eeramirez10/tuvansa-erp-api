import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import { connectPostgres, postgresConfigured, type PostgresClient } from '../../../../../shared/infrastructure/database/postgres-pool.js';
import { hasLocalSalesStock, localOrderAssignmentRows } from '../../../../sales/orders/infrastructure/datasources/sales-order-inventory-stock.js';

export type SaleWarehouseStock = { warehouse: string; quantity: number; assigned: number; lastSaleAt: string | null };
export type LocalSalesStock = { ordered: number; quoted: number; warehouses: SaleWarehouseStock[] };

export async function localSalesProductStocks(ids: number[]): Promise<Map<number, LocalSalesStock>> {
  const results = new Map<number, LocalSalesStock>();
  if (!ids.length || !postgresConfigured()) return results;
  let client: PostgresClient | undefined;
  try {
    client = await connectPostgres();
    const tables = await hasLocalSalesStock(client);
    const grouped = new Map<number, Map<string, SaleWarehouseStock>>();
    const warehouseRecord = (id: number, warehouse: string) => {
      let rows = grouped.get(id);
      if (!rows) { rows = new Map(); grouped.set(id, rows); }
      let row = rows.get(warehouse);
      if (!row) { row = { warehouse, quantity: 0, assigned: 0, lastSaleAt: null }; rows.set(warehouse, row); }
      return row;
    };
    if (tables.orders) {
      const { rows } = await client.query<{ id: string; ordered: string; quoted: string }>(
        `SELECT product_id AS id,sum(ordered) AS ordered,sum(quoted) AS quoted
         FROM tuvansa.order_stock_deltas WHERE product_id=ANY($1::bigint[]) GROUP BY product_id`, [ids],
      );
      for (const row of rows) results.set(Number(row.id), { ordered: Number(row.ordered), quoted: Number(row.quoted), warehouses: [] });
      for (const { productId, warehouse, assigned } of await localOrderAssignmentRows(client, ids)) {
        if (assigned !== 0 && warehouse) warehouseRecord(productId, warehouse).assigned = assigned;
      }
    }
    if (tables.remissions) {
      const { rows } = await client.query<{ id: string; warehouse: string; quantity: string; lastSaleAt: string }>(
        `SELECT movement.product_id AS id,movement.warehouse,sum(movement.quantity) AS quantity,max(source.issued_at)::text AS "lastSaleAt"
         FROM tuvansa.sales_remission_inventory movement JOIN tuvansa.sales_remissions source ON source.id=movement.remittance_id
         WHERE movement.product_id=ANY($1::bigint[]) GROUP BY movement.product_id,movement.warehouse`, [ids],
      );
      for (const { id, warehouse, quantity, lastSaleAt } of rows) {
        const row = warehouseRecord(Number(id), warehouse);
        row.quantity = Number(quantity);
        row.lastSaleAt = lastSaleAt;
      }
    }
    if (tables.adjustments) {
      const { rows } = await client.query<{ id: string; warehouse: string; quantity: string }>(
        `SELECT product_id AS id,warehouse,sum(quantity) AS quantity
         FROM tuvansa.inventory_adjustment_stock WHERE product_id=ANY($1::bigint[]) GROUP BY product_id,warehouse`, [ids],
      );
      for (const { id, warehouse, quantity } of rows) warehouseRecord(Number(id), warehouse).quantity += Number(quantity);
    }
    if (tables.remissionCancellations) {
      const { rows } = await client.query<{ id: string; warehouse: string; quantity: string }>(
        `SELECT product_id AS id,warehouse,sum(quantity) AS quantity
         FROM tuvansa.sales_remission_cancellation_inventory WHERE product_id=ANY($1::bigint[]) GROUP BY product_id,warehouse`, [ids],
      );
      for (const { id, warehouse, quantity } of rows) warehouseRecord(Number(id), warehouse).quantity += Number(quantity);
    }
    for (const [id, warehouses] of grouped) {
      const product = results.get(id) ?? { ordered: 0, quoted: 0, warehouses: [] };
      results.set(id, { ...product, warehouses: [...warehouses.values()] });
    }
    return results;
  } catch {
    throw new ApplicationError('No fue posible consultar el inventario de ventas en PostgreSQL.', 'SALES_STOCK_POSTGRES_UNAVAILABLE', 503);
  } finally { client?.release(); }
}
