import type { Product } from '../../domain/entities/product.js';
import type { ProductsDataSource } from '../../domain/datasources/products-data-source.js';
import type {
  DeleteProductResult,
  ProductCreateValues,
  ProductNavigationDirection,
  ProductSearchCriteria,
  ProductSearchResult,
  ProductsRepository,
  ProductWriteValues,
} from '../../domain/repositories/products-repository.js';

export class ProductsRepositoryImpl implements ProductsRepository {
  constructor(private readonly dataSource: ProductsDataSource) {}

  findById(productId: number): Promise<Product | null> {
    return this.dataSource.findById(productId);
  }

  search(criteria: ProductSearchCriteria): Promise<ProductSearchResult> {
    return this.dataSource.search(criteria);
  }

  findAdjacent(
    productId: number,
    direction: ProductNavigationDirection,
  ): Promise<Product | null> {
    return this.dataSource.findAdjacent(productId, direction);
  }

  codeExists(code: string, excludingProductId?: number): Promise<boolean> {
    return excludingProductId === undefined
      ? this.dataSource.codeExists(code)
      : this.dataSource.codeExists(code, excludingProductId);
  }

  unitExists(unitId: number): Promise<boolean> {
    return this.dataSource.unitExists(unitId);
  }

  accountingAccountExists(account: string): Promise<boolean> {
    return this.dataSource.accountingAccountExists(account);
  }

  create(values: ProductCreateValues): Promise<Product> {
    return this.dataSource.create(values);
  }

  update(productId: number, values: ProductWriteValues): Promise<Product | null> {
    return this.dataSource.update(productId, values);
  }

  delete(productId: number): Promise<DeleteProductResult> {
    return this.dataSource.delete(productId);
  }
}
