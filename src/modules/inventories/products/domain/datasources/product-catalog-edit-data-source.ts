import type { ProductProps } from '../entities/product.js';
import type { StoredProductClassification } from '../repositories/product-classification-repository.js';
import type { StoredProductOtherData } from '../repositories/product-other-data-repository.js';
import type { ProductWriteValues } from '../repositories/products-repository.js';

export type ProductCatalogUnit = Pick<ProductProps['classification']['unit'], 'id' | 'code' | 'description'>;

export type ProductCatalogEditSnapshot = {
  revision: number;
  changes: ProductWriteValues;
  classification: StoredProductClassification | null;
  otherData: StoredProductOtherData | null;
};

export type ProductCatalogEditChanges = {
  catalog: ProductWriteValues;
  familyCode?: string;
  otherData?: StoredProductOtherData['changes'];
};

export type ProductCatalogEditRules = {
  hideCosts: boolean;
  hasComponents: boolean;
  assemblyTypeOverride: boolean;
  colorCode?: string;
  rowCode?: string;
};

export interface ProductCatalogEditDataSource {
  writable(productId: number): boolean;
  get(productId: number): Promise<ProductCatalogEditSnapshot | null>;
  save(productId: number, revision: string, changes: ProductCatalogEditChanges): Promise<ProductCatalogEditSnapshot>;
  searchOverrides(): Promise<ReadonlyMap<number, ProductWriteValues>>;
}

export const productCatalogEditRevision = (snapshot: ProductCatalogEditSnapshot | null): string =>
  `${snapshot?.revision ?? 0}:${snapshot?.classification?.revision ?? 0}:${snapshot?.otherData?.revision ?? 0}`;
