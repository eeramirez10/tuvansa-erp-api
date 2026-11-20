import type { ProductOtherDataCatalogSource, ProductOtherDataStorageDataSource } from '../../domain/datasources/product-other-data-source.js';
import type { ProductOtherDataRepository, StoredProductOtherData } from '../../domain/repositories/product-other-data-repository.js';
import type { ProductCatalogEditDataSource } from '../../domain/datasources/product-catalog-edit-data-source.js';

export class ProductOtherDataRepositoryImpl implements ProductOtherDataRepository {
  constructor(
    private readonly catalogSource: ProductOtherDataCatalogSource,
    private readonly storage: ProductOtherDataStorageDataSource,
    private readonly edits?: Pick<ProductCatalogEditDataSource, 'get'>,
  ) {}

  async catalog(productId: number) {
    const catalog = await this.catalogSource.get(productId);
    if (!catalog) return null;
    const edits = await this.edits?.get(productId);
    const description = edits?.changes.description;
    return description === undefined ? catalog : { ...catalog, product: { ...catalog.product, description } };
  }

  writable(productId: number) {
    return this.storage.writable(productId);
  }

  get(productId: number) {
    return this.storage.get(productId);
  }

  save(productId: number, settings: StoredProductOtherData) {
    return this.storage.save(productId, settings);
  }
}
