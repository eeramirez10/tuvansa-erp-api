import type { ProductPanelsDataSource } from '../../domain/datasources/product-panels-data-source.js';
import type { ProductOtherDataRepository } from '../../domain/repositories/product-other-data-repository.js';
import type { ProductCatalogEditDataSource } from '../../domain/datasources/product-catalog-edit-data-source.js';
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
    private readonly edits?: Pick<ProductCatalogEditDataSource, 'get'>,
  ) {}

  async getPanel(
    productId: number,
    panel: ProductPanelKey,
    criteria: ProductPanelCriteria,
  ): Promise<ProductPanelResult | null> {
    const result = await this.dataSource.getPanel(productId, panel, criteria);
    if (panel !== 'prices' || !result?.items.length) return result;
    const edit = await this.edits?.get(productId);
    const saved = edit ? edit.otherData : await this.otherData?.get(productId);
    if (!saved && !edit) return result;
    const fields = saved?.changes ?? {};
    const prices = Object.fromEntries(Object.entries(fields).filter(([key]) => /^(list|currency)([6-9]|1[0-3])$/.test(key)));
    if (fields.list4 !== undefined) prices.cost = fields.list4;
    for (const number of [1, 2, 3, 11]) {
      const amount = fields[`planPrice${number}`];
      if (amount !== undefined) prices[`posPlan${number}`] = amount;
    }
    const changes = edit?.changes;
    for (const number of [1, 2, 3] as const) {
      const amount = changes?.[`salePrice${number}`];
      const currency = changes?.[`saleCurrency${number}`];
      if (amount !== undefined) prices[`list${number}`] = amount;
      if (currency !== undefined) prices[`currency${number}`] = currency;
    }
    const description = changes?.description ?? result.product.description;
    return { ...result, product: { ...result.product, description }, items: result.items.map((item) => ({ ...item, ...prices })) };
  }

  setBlocked(productId: number, blocked: boolean): Promise<ProductBlockStatus | null> {
    return this.dataSource.setBlocked(productId, blocked);
  }
}
