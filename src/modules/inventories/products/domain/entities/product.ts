export type ProductType =
  | 'rawMaterial'
  | 'finishedProduct'
  | 'set'
  | 'assembly'
  | 'service'
  | 'unknown';

export interface ProductProps {
  id: number;
  code: string;
  description: string;
  isActive: boolean;
  deactivatedAt: string | null;
  classification: {
    type: ProductType;
    familyCode: string;
    unit: {
      id: number;
      code: string;
      description: string;
    };
    usesColorAndSize: boolean;
    hasPhoto: boolean;
  };
  prices: {
    sale: [
      { amount: number; currencyId: number },
      { amount: number; currencyId: number },
      { amount: number; currencyId: number },
    ];
    costs: {
      average: number;
      last: number;
      previous: number;
      currencyId: number;
      adValorem: number;
    };
  };
  warehouse: {
    minimum: number;
    maximum: number;
    location: string;
    ean: string;
    upc: string;
    accounts: {
      primary: string;
      secondary: string;
      costOfSales: string;
    };
  };
  accumulated: {
    lastPurchaseAt: string | null;
    lastSaleAt: string | null;
    assigned: number;
    confirmed: number;
    customerOrders: number;
    customerQuotes: number;
    supplierOrders: number;
    supplierQuotes: number;
    currentStock: number;
    previousStock: number;
    accumulatedStock: number;
    previousQuantity: number;
    accumulatedQuantity: number;
    pieceStock: number;
    salesLastSixMonths: number;
    inventoryDays: number;
  };
  createdAt: string | null;
}

export class Product {
  private constructor(private readonly props: ProductProps) {}

  static create(props: ProductProps): Product {
    return new Product(props);
  }

  toPrimitives(): ProductProps {
    return { ...this.props };
  }
}
