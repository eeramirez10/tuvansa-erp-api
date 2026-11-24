import { readLocalPurchaseReceptions } from '../../../../purchasing/purchase-receptions/infrastructure/datasources/postgres-purchase-reception-writes.js';
import { purchaseReceptionCancellationsAvailable } from '../../../../purchasing/purchase-receptions/infrastructure/datasources/purchase-posting-reversal-tables.js';

export interface ReceiptWarehouseTotals {
  warehouse: string;
  quantity: number;
  lastPurchaseAt: string | null;
}

export async function purchaseReceptionProductInventories(productIds: number[]): Promise<Map<number, ReceiptWarehouseTotals[]>> {
  if (productIds.length === 0) return new Map();
  return readLocalPurchaseReceptions(new Map<number, ReceiptWarehouseTotals[]>(), async (client) => {
    // Derivada. Entradas locales por producto y almacén.
    const cancellations = await purchaseReceptionCancellationsAvailable(client);
    const { rows } = await client.query<ReceiptWarehouseTotals & { productId: number }>(
      `SELECT product_id::float8 AS "productId",warehouse,sum(quantity)::float8 AS quantity,max(date) AS "lastPurchaseAt"
       FROM (
         SELECT i.product_id,i.warehouse,i.quantity,
           ${cancellations ? 'CASE WHEN c.id IS NULL THEN r.movement #>> \'{header,date}\' END' : "r.movement #>> '{header,date}'"} AS date
         FROM tuvansa.purchase_reception_inventory i JOIN tuvansa.purchase_receptions r ON r.id=i.receipt_id
         ${cancellations ? 'LEFT JOIN tuvansa.purchase_reception_cancellations c ON c.receipt_id=r.id' : ''}
         WHERE i.product_id=ANY($1::bigint[])
         ${cancellations ? `UNION ALL
           SELECT product_id,warehouse,quantity,NULL::text FROM tuvansa.purchase_reception_cancellation_inventory
           WHERE product_id=ANY($1::bigint[])` : ''}
       ) movements GROUP BY product_id,warehouse HAVING sum(quantity)<>0 ORDER BY warehouse`, [productIds],
    );
    const grouped = new Map<number, ReceiptWarehouseTotals[]>();
    for (const { productId, ...totals } of rows) {
      const existing = grouped.get(productId);
      if (existing) existing.push(totals);
      else grouped.set(productId, [totals]);
    }
    return grouped;
  });
}

export async function purchaseReceptionProductInventory(productId: number): Promise<ReceiptWarehouseTotals[]> {
  return (await purchaseReceptionProductInventories([productId])).get(productId) ?? [];
}
