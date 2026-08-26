import type { Product } from '../entities/product.js';
import type {
  DeleteProductResult,
  ProductCreateValues,
  ProductNavigationDirection,
  ProductSearchCriteria,
  ProductSearchResult,
  ProductWriteValues,
} from '../repositories/products-repository.js';

export interface ProductsDataSource {
  findById(productId: number): Promise<Product | null>;
  search(criteria: ProductSearchCriteria): Promise<ProductSearchResult>;
  findAdjacent(
    productId: number,
    direction: ProductNavigationDirection,
  ): Promise<Product | null>;
  codeExists(code: string, excludingProductId?: number): Promise<boolean>;
  unitExists(unitId: number): Promise<boolean>;
  accountingAccountExists(account: string): Promise<boolean>;
  create(values: ProductCreateValues): Promise<Product>;
  update(productId: number, values: ProductWriteValues): Promise<Product | null>;
  delete(productId: number): Promise<DeleteProductResult>;
}
