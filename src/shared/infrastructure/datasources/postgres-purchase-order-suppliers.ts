import { ApplicationError } from '../../domain/errors/application-error.js';
import { connectPostgres, postgresConfigured, type PostgresClient } from '../database/postgres-pool.js';

type PurchaseOrderSupplierChange = {
  id: number;
  number: string;
  supplier: { id: number; code: string; name: string };
  supplierDiscounts: [number, number];
  taxType: number;
  revision: number;
  supplierParameter: string | null;
};

export async function readPurchaseOrderSupplierChanges(client: PostgresClient, ids?: number[]): Promise<PurchaseOrderSupplierChange[]> {
  const { rows: [table] } = await client.query<{ available: boolean; versioned: boolean }>(
    `SELECT to_regclass('tuvansa.purchase_order_supplier_changes') IS NOT NULL AS available,
       EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('tuvansa.purchase_order_supplier_changes')
         AND attname='revision' AND NOT attisdropped) AS versioned`,
  );
  if (!table?.available) return [];
  const { rows } = await client.query<Omit<PurchaseOrderSupplierChange, 'id'> & { id: string }>(
    `SELECT DISTINCT ON (order_id,order_number) order_id AS id, order_number AS number,
       supplier, supplier_discounts AS "supplierDiscounts", tax_type AS "taxType",
       ${table.versioned ? 'revision, supplier_parameter' : '1 AS revision, NULL::text'} AS "supplierParameter"
     FROM tuvansa.purchase_order_supplier_changes ${ids ? 'WHERE order_id = ANY($1::bigint[])' : ''}
     ORDER BY order_id,order_number,revision DESC`, ids ? [ids] : [],
  );
  return rows.map(({ id, ...change }) => ({ ...change, id: Number(id) }));
}

export async function purchaseOrderSupplierChanges(ids: number[]): Promise<PurchaseOrderSupplierChange[]> {
  if (ids.length === 0 || !postgresConfigured()) return [];
  let client: PostgresClient | undefined;
  try {
    client = await connectPostgres();
    return await readPurchaseOrderSupplierChanges(client, ids);
  } catch {
    throw new ApplicationError('No fue posible consultar los cambios de proveedor.', 'PURCHASE_ORDER_POSTGRES_UNAVAILABLE', 503);
  } finally {
    client?.release();
  }
}
