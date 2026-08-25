export interface ClientProps {
  id: number;
  code: string;
  name: string;
  isActive: boolean;
  deactivatedAt: string | null;
  address: {
    street: string;
    exteriorNumber: string;
    interiorNumber: string;
    neighborhood: string;
    borough: string;
    city: string;
    state: string;
    postalCode: string;
    countryCode: string;
  };
  contact: {
    name: string;
    phones: string;
    fax: string;
    email: string;
    website: string;
  };
  fiscal: {
    taxId: string;
    curp: string;
    branch: string;
    accountingAccount: string;
  };
  indicators: {
    hasEvents: boolean;
  };
  terms: {
    priceList: number;
    discounts: [number, number, number];
    paymentTermDays: number;
    creditLimit: number;
    creditExpiresAt: string | null;
    reviewDay: string;
    reviewTime: string;
    paymentDay: string;
    paymentTime: string;
    applyToClientCode: string;
    reviewStartsFromInvoice: boolean;
  };
  totals: {
    actualPaymentTermDays: number;
    previousBalance: number;
    currentBalance: number;
    availableCredit: number;
    accumulatedSales: number;
    lastPurchaseAt: string | null;
    lastPaymentAt: string | null;
    lastOrderAt: string | null;
  };
  createdAt: string | null;
}

export class Client {
  private constructor(private readonly props: ClientProps) {}

  static create(props: ClientProps): Client {
    return new Client(props);
  }

  toPrimitives(): ClientProps {
    return { ...this.props };
  }
}
