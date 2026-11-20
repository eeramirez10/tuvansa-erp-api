import type { ProductPanelsDataSource } from '../../domain/datasources/product-panels-data-source.js';
import type { ProductOtherDataRepository } from '../../domain/repositories/product-other-data-repository.js';
import type {
  ProductPanelCriteria,
  ProductBlockStatus,
  ProductPanelKey,
  ProductPanelResult,
  ProductPanelsRepository,
} from '../../domain/repositories/product-panels-repository.js';

export class ProductPanelsRepositoryImpl implements ProductPanelsRepository {
  constructor(
    private readonly dataSource: ProductPanelsDataSource,
    private readonly otherData?: Pick<ProductOtherDataRepository, 'get'>,
  ) {}

  async getPanel(
    productId: number,
    panel: ProductPanelKey,
    criteria: ProductPanelCriteria,
  ): Promise<ProductPanelResult | null> {
    const result = await this.dataSource.getPanel(productId, panel, criteria);
    if (panel !== 'prices' || !result?.items.length) return result;
    const saved = await this.otherData?.get(productId);
    if (!saved) return result;
    const prices = Object.fromEntries(Object.entries(saved.changes).filter(([key]) => /^(list|currency)([6-9]|1[0-3])$/.test(key)));
    if (saved.changes.list4 !== undefined) prices.cost = saved.changes.list4;
    for (const number of [1, 2, 3, 11]) {
      const amount = saved.changes[`planPrice${number}`];
      if (amount !== undefined) prices[`posPlan${number}`] = amount;
    }
    return { ...result, items: result.items.map((item) => ({ ...item, ...prices })) };
  }

  setBlocked(productId: number, blocked: boolean): Promise<ProductBlockStatus | null> {
    return this.dataSource.setBlocked(productId, blocked);
  }
}
