import type { Product, ProductType } from '../entities/product.js';

export interface ProductSearchCriteria {
  query?: string;
  status: 'active' | 'inactive' | 'all';
  limit: number;
  offset: number;
}

export interface ProductSearchResult {
  items: Product[];
  total: number;
}

export type ProductNavigationDirection = 'previous' | 'next';

export interface ProductWriteValues {
  code?: string;
  description?: string;
  type?: ProductType;
  unitId?: number;
  familyCode?: string;
  hasPhoto?: boolean;
  salePrice1?: number;
  salePrice2?: number;
  salePrice3?: number;
  saleCurrency1?: number;
  saleCurrency2?: number;
  saleCurrency3?: number;
  averageCost?: number;
  lastCost?: number;
  previousCost?: number;
  costCurrency?: number;
  adValorem?: number;
  minimum?: number;
  maximum?: number;
  location?: string;
  ean?: string;
  upc?: string;
  primaryAccount?: string;
  secondaryAccount?: string;
  costOfSalesAccount?: string;
}

export interface ProductCreateValues extends ProductWriteValues {
  code: string;
  description: string;
}

export type DeleteProductResult =
  | { status: 'deleted' }
  | { status: 'not-found' }
  | { status: 'in-use'; relation: string };

export interface ProductsRepository {
  findById(productId: number): Promise<Product | null>;
  findFirstActive(): Promise<Product | null>;
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
