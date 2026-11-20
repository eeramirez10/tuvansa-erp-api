import { Product } from '../../domain/entities/product.js';
import type { ProductsDataSource } from '../../domain/datasources/products-data-source.js';
import type { ProductClassificationRepository } from '../../domain/repositories/product-classification-repository.js';
import type { ProductOtherDataRepository } from '../../domain/repositories/product-other-data-repository.js';
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
    private readonly otherData?: Pick<ProductOtherDataRepository, 'get'>,
  ) {}

  private async withPilotValues(product: Product | null): Promise<Product | null> {
    if (!product) return null;
    const details = product.toPrimitives();
    const [classification, otherData] = await Promise.all([
      this.classification?.get(details.id), this.otherData?.get(details.id),
    ]);
    const changes = otherData?.changes;
    const familyCode = classification?.familyCode;
    if (familyCode == null && !changes) return product;

    const costs = details.prices.costs;
    return Product.create({
      ...details,
      classification: { ...details.classification, familyCode: familyCode ?? details.classification.familyCode },
      warehouse: { ...details.warehouse, location: typeof changes?.location === 'string' ? changes.location : details.warehouse.location },
      prices: { ...details.prices, costs: {
        ...costs,
        average: typeof changes?.list4 === 'number' ? changes.list4 : costs.average,
        last: typeof changes?.list5 === 'number' ? changes.list5 : costs.last,
        previous: typeof changes?.list6 === 'number' ? changes.list6 : costs.previous,
        currencyId: typeof changes?.baseCurrency === 'number' ? changes.baseCurrency : costs.currencyId,
      } },
    });
  }

  async findById(productId: number): Promise<Product | null> {
    return this.withPilotValues(await this.dataSource.findById(productId));
  }

  async findFirstActive(): Promise<Product | null> {
    return this.withPilotValues(await this.dataSource.findFirstActive());
  }

  search(criteria: ProductSearchCriteria): Promise<ProductSearchResult> {
    return this.dataSource.search(criteria);
  }

  async findAdjacent(
    productId: number,
    direction: ProductNavigationDirection,
  ): Promise<Product | null> {
    return this.withPilotValues(await this.dataSource.findAdjacent(productId, direction));
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
