export interface InvoiceLine {
  id: number;
  productId: number;
  productCode: string;
  description: string;
  quantity: number;
  fulfilledQuantity: number;
  unit: string;
  price: number;
  grossPrice: number;
  discount: number;
  amount: number;
  branch: number;
  agent: string;
  pieces: number;
  page: number;
  factor: number;
  cost: number;
  package: string;
  sku: string;
  family: string;
}

export interface InvoiceProps {
  id: number;
  number: string;
  orderNumber: string;
  customerOrderNumber: string;
  customer: { id: number; code: string; name: string; billedName: string };
  movementType: string;
  status: string;
  canceled: boolean;
  dates: {
    issuedAt: string | null;
    dueAt: string | null;
    paidAt: string | null;
    deliveryNoteAt: string | null;
  };
  delayDays: number;
  attention: string;
  attentionCode: string;
  branch: number;
  department: string;
  route: number;
  pieces: number;
  warehouse: string;
  currency: { id: number; name: string; exchangeRate: number };
  initial: boolean;
  cfdStatus: string;
  folio: string;
  deliveryNote: string;
  warehouseSeal: string;
  discountPercentages: number[];
  totals: {
    quantity: number;
    fulfilledQuantity: number;
    subtotal: number;
    discount: number;
    freight: number;
    insurance: number;
    other: number;
    exciseTax: number;
    tax: number;
    total: number;
    paid: number;
    balance: number;
  };
  lines: InvoiceLine[];
}

export class Invoice {
  private constructor(private readonly props: InvoiceProps) {}

  static create(props: InvoiceProps): Invoice {
    return new Invoice(props);
  }

  toPrimitives(): InvoiceProps {
    return structuredClone(this.props);
  }
}
