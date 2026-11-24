import type { ProductOtherDataValues } from '../entities/product-other-data.js';
import type { ProductPanelResult } from './product-panels-repository.js';

export interface ProductTariff {
  code: string;
  description: string;
  percentage: number | null;
}

export interface ProductOtherDataCatalog {
  product: ProductPanelResult['product'];
  values: ProductOtherDataValues;
  tariffs: ProductTariff[];
  miscLabels: string[];
  derivesList6: boolean;
}

export interface StoredProductOtherData {
  revision: number;
  changes: ProductOtherDataValues;
  changedAt?: string;
}

export interface ProductOtherDataRepository {
  catalog(productId: number): Promise<ProductOtherDataCatalog | null>;
  writable(productId: number): boolean | Promise<boolean>;
  get(productId: number): Promise<StoredProductOtherData | null>;
  save(productId: number, settings: StoredProductOtherData): Promise<StoredProductOtherData>;
}
