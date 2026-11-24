import type {
  ProductClassificationCatalog,
  StoredProductClassification,
} from '../repositories/product-classification-repository.js';

export interface ProductClassificationCatalogDataSource {
  get(productId: number): Promise<ProductClassificationCatalog | null>;
}

export interface ProductClassificationStorageDataSource {
  writable(productId: number): boolean | Promise<boolean>;
  get(productId: number): Promise<StoredProductClassification | null>;
  save(productId: number, classification: StoredProductClassification): Promise<StoredProductClassification>;
}
