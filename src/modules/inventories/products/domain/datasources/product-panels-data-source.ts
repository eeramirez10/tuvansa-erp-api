import type {
  ProductPanelCriteria,
  ProductBlockStatus,
  ProductPanelKey,
  ProductPanelResult,
} from '../repositories/product-panels-repository.js';

export interface ProductPanelsDataSource {
  getPanel(
    productId: number,
    panel: ProductPanelKey,
    criteria: ProductPanelCriteria,
  ): Promise<ProductPanelResult | null>;
  setBlocked(productId: number, blocked: boolean): Promise<ProductBlockStatus | null>;
}
