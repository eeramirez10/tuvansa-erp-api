export type OrderDocumentKind = 'order' | 'quote' | 'unknown';

export interface OrderLine {
  id: number;
  productId: number;
  productCode: string;
  description: string;
  ordered: number;
  fulfilled: number;
  remaining: number;
  unit: string;
  assigned: number;
  branch: number;
  price: number;
  classCode: string;
  currencyId: number;
  piecesAssignment: string;
  discount: number;
  publicPrice: number;
  sku: string;
  color: string;
  size: string;
}

export interface OrderProps {
  id: number;
  number: string;
  customerOrderNumber: string;
  customer: { id: number; code: string; name: string };
  documentKind: OrderDocumentKind;
  status: string;
  fulfilledAmount: number;
  branch: number;
  department: string;
  dates: { orderedAt: string | null; from: string | null; dueAt: string | null };
  attention: string;
  termsDays: number;
  authorization: string;
  initial: boolean;
  warehouse: string;
  currencyId: number;
  exchangeRate: number;
  minimumFulfillmentPercentage: number;
  observations: string;
  classifications: string[];
  totals: {
    quantity: number;
    ordered: number;
    fulfilled: number;
    remaining: number;
    subtotal: number;
    discount: number;
    freight: number;
    insurance: number;
    other: number;
    tax: number;
    total: number;
  };
  lines: OrderLine[];
}

export class Order {
  private constructor(private readonly props: OrderProps) {}

  static create(props: OrderProps): Order {
    return new Order(props);
  }

  toPrimitives(): OrderProps {
    return structuredClone(this.props);
  }
}
