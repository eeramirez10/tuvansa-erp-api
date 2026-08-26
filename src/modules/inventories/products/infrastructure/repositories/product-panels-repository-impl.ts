import type { ProductPanelsDataSource } from '../../domain/datasources/product-panels-data-source.js';
import type {
  ProductPanelCriteria,
  ProductBlockStatus,
  ProductPanelKey,
  ProductPanelResult,
  ProductPanelsRepository,
} from '../../domain/repositories/product-panels-repository.js';

export class ProductPanelsRepositoryImpl implements ProductPanelsRepository {
  constructor(private readonly dataSource: ProductPanelsDataSource) {}

  getPanel(
    productId: number,
    panel: ProductPanelKey,
    criteria: ProductPanelCriteria,
  ): Promise<ProductPanelResult | null> {
    return this.dataSource.getPanel(productId, panel, criteria);
  }

  setBlocked(productId: number, blocked: boolean): Promise<ProductBlockStatus | null> {
    return this.dataSource.setBlocked(productId, blocked);
  }
}
