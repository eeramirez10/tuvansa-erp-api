import type {
  ProductClassificationCatalogDataSource,
  ProductClassificationStorageDataSource,
} from '../../domain/datasources/product-classification-data-source.js';
import type {
  ProductClassificationRepository,
  StoredProductClassification,
} from '../../domain/repositories/product-classification-repository.js';
import type { ProductCatalogEditDataSource } from '../../domain/datasources/product-catalog-edit-data-source.js';

export class ProductClassificationRepositoryImpl implements ProductClassificationRepository {
  constructor(
    private readonly catalogSource: ProductClassificationCatalogDataSource,
    private readonly storage: ProductClassificationStorageDataSource,
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

  save(productId: number, classification: StoredProductClassification) {
    return this.storage.save(productId, classification);
  }
}
