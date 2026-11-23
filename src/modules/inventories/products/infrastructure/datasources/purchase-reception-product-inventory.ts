import { readLocalPurchaseReceptions } from '../../../../purchasing/purchase-receptions/infrastructure/datasources/postgres-purchase-reception-writes.js';

export interface ReceiptWarehouseTotals {
  warehouse: string;
  quantity: number;
  lastPurchaseAt: string | null;
}

export async function purchaseReceptionProductInventories(productIds: number[]): Promise<Map<number, ReceiptWarehouseTotals[]>> {
  if (productIds.length === 0) return new Map();
  return readLocalPurchaseReceptions(new Map<number, ReceiptWarehouseTotals[]>(), async (client) => {
    // Derivada. Entradas locales por producto y almacén.
    const { rows } = await client.query<ReceiptWarehouseTotals & { productId: number }>(
      `SELECT inventory.product_id::float8 AS "productId", inventory.warehouse, sum(inventory.quantity)::float8 AS quantity,
              max(receipt.movement #>> '{header,date}') AS "lastPurchaseAt"
       FROM tuvansa.purchase_reception_inventory AS inventory
       JOIN tuvansa.purchase_receptions AS receipt ON receipt.id = inventory.receipt_id
       WHERE inventory.product_id = ANY($1::bigint[])
       GROUP BY inventory.product_id, inventory.warehouse ORDER BY inventory.warehouse`, [productIds],
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
