import { purchaseOrderInventoryAdjustment } from '../../../../../shared/infrastructure/datasources/postgres-purchase-order-pending.js';
import { Product, type ProductProps } from '../../domain/entities/product.js';
import type { ProductNavigationDirection, ProductSearchCriteria } from '../../domain/repositories/products-repository.js';
import { LegacyMysqlProductsDataSource } from './legacy-mysql-products-data-source.js';
import { localSalesProductStocks, type LocalSalesStock } from './local-sales-product-inventory.js';
import {
  purchaseReceptionProductInventories, purchaseReceptionProductInventory, type ReceiptWarehouseTotals,
} from './purchase-reception-product-inventory.js';

function addReceiptInventory(
  accumulated: ProductProps['accumulated'], inventory: ReceiptWarehouseTotals[],
): ProductProps['accumulated'] {
  const stock = inventory.reduce((total, { quantity }) => total + quantity, 0);
  const lastPurchaseAt = inventory.reduce((latest, receipt) => {
    return receipt.lastPurchaseAt && (!latest || receipt.lastPurchaseAt > latest) ? receipt.lastPurchaseAt : latest;
  }, accumulated.lastPurchaseAt);
  return {
    ...accumulated,
    currentStock: Number((accumulated.currentStock + stock).toFixed(3)),
    lastPurchaseAt,
  };
}

function addSalesInventory(accumulated: ProductProps['accumulated'], stock?: LocalSalesStock): ProductProps['accumulated'] {
  if (!stock) return accumulated;
  let { currentStock, assigned, lastSaleAt } = accumulated;
  for (const row of stock.warehouses) {
    currentStock += row.quantity;
    assigned += row.assigned;
    if (row.lastSaleAt && (!lastSaleAt || row.lastSaleAt > lastSaleAt)) lastSaleAt = row.lastSaleAt;
  }
  return {
    ...accumulated, lastSaleAt, currentStock: Number(currentStock.toFixed(3)), assigned: Number(assigned.toFixed(3)),
    customerOrders: Number((accumulated.customerOrders + stock.ordered).toFixed(3)),
    customerQuotes: Number((accumulated.customerQuotes + stock.quoted).toFixed(3)),
  };
}

export class ProductsWithPurchaseOrderPendingDataSource extends LegacyMysqlProductsDataSource {
  private async withPending(request: Promise<Product | null>): Promise<Product | null> {
    const product = await request;
    if (!product) return null;
    const details = product.toPrimitives();
    const [{ pending, confirmed, quotes }, inventory, sales] = await Promise.all([
      purchaseOrderInventoryAdjustment(details.id), purchaseReceptionProductInventory(details.id), localSalesProductStocks([details.id]),
    ]);
    if (pending === 0 && confirmed === 0 && quotes === 0 && inventory.length === 0 && sales.size === 0) return product;
    const accumulated = addSalesInventory(addReceiptInventory(details.accumulated, inventory), sales.get(details.id));
    return Product.create({
      ...details,
      accumulated: {
        ...accumulated,
        supplierOrders: Number((details.accumulated.supplierOrders + pending).toFixed(2)),
        supplierQuotes: Number((details.accumulated.supplierQuotes + quotes).toFixed(2)),
        confirmed: Number((details.accumulated.confirmed + confirmed).toFixed(3)),
      },
    });
  }

  override findById(id: number) { return this.withPending(super.findById(id)); }
  override findFirstActive() { return this.withPending(super.findFirstActive()); }
  override findAdjacent(id: number, direction: ProductNavigationDirection) {
    return this.withPending(super.findAdjacent(id, direction));
  }

  override async search(criteria: ProductSearchCriteria) {
    const result = await super.search(criteria);
    const ids = result.items.map((item) => item.toPrimitives().id);
    const [inventory, sales] = await Promise.all([purchaseReceptionProductInventories(ids), localSalesProductStocks(ids)]);
    return { ...result, items: result.items.map((item) => {
      const props = item.toPrimitives();
      const totals = inventory.get(props.id);
      const stock = sales.get(props.id);
      return totals || stock ? Product.create({ ...props, accumulated: addSalesInventory(addReceiptInventory(props.accumulated, totals ?? []), stock) }) : item;
    }) };
  }
}
