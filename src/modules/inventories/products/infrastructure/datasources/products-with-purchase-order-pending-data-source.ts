import { purchaseOrderPendingAdjustment } from '../../../../../shared/infrastructure/datasources/postgres-purchase-order-pending.js';
import { Product } from '../../domain/entities/product.js';
import type { ProductNavigationDirection } from '../../domain/repositories/products-repository.js';
import { LegacyMysqlProductsDataSource } from './legacy-mysql-products-data-source.js';

export class ProductsWithPurchaseOrderPendingDataSource extends LegacyMysqlProductsDataSource {
  private async withPending(request: Promise<Product | null>): Promise<Product | null> {
    const product = await request;
    if (!product) return null;
    const details = product.toPrimitives();
    const adjustment = await purchaseOrderPendingAdjustment(details.id);
    if (adjustment === 0) return product;
    return Product.create({
      ...details,
      accumulated: {
        ...details.accumulated,
        supplierOrders: Number((details.accumulated.supplierOrders + adjustment).toFixed(2)),
      },
    });
  }

  override findById(id: number) { return this.withPending(super.findById(id)); }
  override findFirstActive() { return this.withPending(super.findFirstActive()); }
  override findAdjacent(id: number, direction: ProductNavigationDirection) {
    return this.withPending(super.findAdjacent(id, direction));
  }
}
