import type {
  ProductClassificationCatalogDataSource,
  ProductClassificationStorageDataSource,
} from '../../domain/datasources/product-classification-data-source.js';
import type {
  ProductClassificationRepository,
  StoredProductClassification,
} from '../../domain/repositories/product-classification-repository.js';

export class ProductClassificationRepositoryImpl implements ProductClassificationRepository {
  constructor(
    private readonly catalogSource: ProductClassificationCatalogDataSource,
    private readonly storage: ProductClassificationStorageDataSource,
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

  save(productId: number, classification: StoredProductClassification) {
    return this.storage.save(productId, classification);
  }
}
