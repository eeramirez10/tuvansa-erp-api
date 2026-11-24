import type { ProductOtherDataCatalog, StoredProductOtherData } from '../repositories/product-other-data-repository.js';

export interface ProductOtherDataCatalogSource {
  get(productId: number): Promise<ProductOtherDataCatalog | null>;
}

export interface ProductOtherDataStorageDataSource {
  writable(productId: number): boolean | Promise<boolean>;
  get(productId: number): Promise<StoredProductOtherData | null>;
  save(productId: number, settings: StoredProductOtherData): Promise<StoredProductOtherData>;
}
