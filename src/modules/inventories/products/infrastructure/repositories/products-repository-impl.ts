import { Product } from '../../domain/entities/product.js';
import type { ProductsDataSource } from '../../domain/datasources/products-data-source.js';
import type { ProductClassificationRepository } from '../../domain/repositories/product-classification-repository.js';
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
  constructor(
    private readonly dataSource: ProductsDataSource,
    private readonly classification?: Pick<ProductClassificationRepository, 'get'>,
  ) {}

  private async withClassification(product: Product | null): Promise<Product | null> {
    if (!product || !this.classification) return product;
    const details = product.toPrimitives();
    const saved = await this.classification.get(details.id);
    if (saved?.familyCode == null) return product;
    return Product.create({ ...details, classification: { ...details.classification, familyCode: saved.familyCode } });
  }

  async findById(productId: number): Promise<Product | null> {
    return this.withClassification(await this.dataSource.findById(productId));
  }

  async findFirstActive(): Promise<Product | null> {
    return this.withClassification(await this.dataSource.findFirstActive());
  }

  search(criteria: ProductSearchCriteria): Promise<ProductSearchResult> {
    return this.dataSource.search(criteria);
  }

  async findAdjacent(
    productId: number,
    direction: ProductNavigationDirection,
  ): Promise<Product | null> {
    return this.withClassification(await this.dataSource.findAdjacent(productId, direction));
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
