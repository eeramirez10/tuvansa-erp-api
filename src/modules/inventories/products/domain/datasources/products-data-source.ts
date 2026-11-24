import type { Product } from '../entities/product.js';
import type { ProductCatalogEditRules, ProductCatalogUnit } from './product-catalog-edit-data-source.js';
import type {
  DeleteProductResult,
  ProductCreateValues,
  ProductNavigationDirection,
  ProductRemovalConfirmation,
  ProductRemovalPreview,
  ProductSearchCriteria,
  ProductSearchResult,
  ProductWriteValues,
} from '../repositories/products-repository.js';

export interface ProductsDataSource {
  findById(productId: number): Promise<Product | null>;
  findFirstActive(): Promise<Product | null>;
  search(criteria: ProductSearchCriteria, overrides?: ReadonlyMap<number, ProductWriteValues>): Promise<ProductSearchResult>;
  listUnits?(): Promise<ProductCatalogUnit[]>;
  catalogWritable?(): Promise<boolean>;
  removal?(productId: number): Promise<ProductRemovalPreview | null>;
  getEditRules?(code: string, unitId: number): Promise<ProductCatalogEditRules>;
  findAdjacent(
    productId: number,
    direction: ProductNavigationDirection,
  ): Promise<Product | null>;
  codeExists(code: string, excludingProductId?: number): Promise<boolean>;
  unitExists(unitId: number): Promise<boolean>;
  accountingAccountExists(account: string): Promise<boolean>;
  create(values: ProductCreateValues): Promise<Product>;
  update(productId: number, values: ProductWriteValues, revision?: string): Promise<Product | null>;
  delete(productId: number, confirmation?: ProductRemovalConfirmation): Promise<DeleteProductResult>;
}
