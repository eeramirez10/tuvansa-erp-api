import type { ProductOtherDataCatalogSource, ProductOtherDataStorageDataSource } from '../../domain/datasources/product-other-data-source.js';
import type { ProductOtherDataRepository, StoredProductOtherData } from '../../domain/repositories/product-other-data-repository.js';
import type { ProductCatalogEditDataSource } from '../../domain/datasources/product-catalog-edit-data-source.js';

export class ProductOtherDataRepositoryImpl implements ProductOtherDataRepository {
  constructor(
    private readonly catalogSource: ProductOtherDataCatalogSource,
    private readonly storage: ProductOtherDataStorageDataSource,
    private readonly edits?: Pick<ProductCatalogEditDataSource, 'get'>,
    private readonly receivedWithPieces?: (productId: number) => Promise<boolean>,
  ) {}

  async catalog(productId: number) {
    const catalog = await this.catalogSource.get(productId);
    if (!catalog) return null;
    const [edits, received] = await Promise.all([this.edits?.get(productId), this.receivedWithPieces?.(productId)]);
    const description = edits?.changes.description;
    return {
      ...catalog,
      product: description === undefined ? catalog.product : { ...catalog.product, description },
      values: received ? { ...catalog.values, controlsPieces: true } : catalog.values,
    };
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
