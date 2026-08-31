export interface SupplierProps {
  id: number;
  code: string;
  name: string;
  isActive: boolean;
  deactivatedAt: string | null;
  address: {
    street: string;
    neighborhood: string;
    city: string;
    state: string;
    postalCode: string;
  };
  contact: {
    name: string;
    phone: string;
    phone2: string;
    fax: string;
    email: string;
  };
  fiscal: {
    taxId: string;
    curp: string;
    accountingAccount: string;
  };
  terms: {
    priceList: number;
    discounts: [number, number];
    paymentTermDays: number;
    applyToSupplierCode: string;
    creditLimit: number;
    currencyId: number;
    type: number;
  };
  totals: {
    actualPaymentTermDays: number;
    previousBalance: number;
    currentBalance: number;
    accumulatedPurchases: number;
    lastPurchaseAt: string | null;
    lastPaymentAt: string | null;
  };
  indicators: { hasEvents: boolean };
  notes: string;
  createdAt: string | null;
}

export class Supplier {
  private constructor(private readonly props: SupplierProps) {}

  static create(props: SupplierProps): Supplier {
    return new Supplier(props);
  }

  toPrimitives(): SupplierProps {
    return { ...this.props };
  }
}
