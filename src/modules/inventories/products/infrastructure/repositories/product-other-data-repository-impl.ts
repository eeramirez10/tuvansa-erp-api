import type { ProductOtherDataCatalogSource, ProductOtherDataStorageDataSource } from '../../domain/datasources/product-other-data-source.js';
import type { ProductOtherDataRepository, StoredProductOtherData } from '../../domain/repositories/product-other-data-repository.js';

export class ProductOtherDataRepositoryImpl implements ProductOtherDataRepository {
  constructor(
    private readonly catalogSource: ProductOtherDataCatalogSource,
    private readonly storage: ProductOtherDataStorageDataSource,
  ) {}

  catalog(productId: number) {
    return this.catalogSource.get(productId);
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
