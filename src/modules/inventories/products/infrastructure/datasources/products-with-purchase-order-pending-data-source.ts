import { purchaseOrderInventoryAdjustment } from '../../../../../shared/infrastructure/datasources/postgres-purchase-order-pending.js';
import { Product } from '../../domain/entities/product.js';
import type { ProductNavigationDirection } from '../../domain/repositories/products-repository.js';
import { LegacyMysqlProductsDataSource } from './legacy-mysql-products-data-source.js';

export class ProductsWithPurchaseOrderPendingDataSource extends LegacyMysqlProductsDataSource {
  private async withPending(request: Promise<Product | null>): Promise<Product | null> {
    const product = await request;
    if (!product) return null;
    const details = product.toPrimitives();
    const { pending, confirmed, quotes } = await purchaseOrderInventoryAdjustment(details.id);
    if (pending === 0 && confirmed === 0 && quotes === 0) return product;
    return Product.create({
      ...details,
      accumulated: {
        ...details.accumulated,
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
}
