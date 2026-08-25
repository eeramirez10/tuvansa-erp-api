export interface ClientBalanceDocumentProps {
  id: number;
  number: string;
  date: string;
  dueDate: string;
  daysOverdue: number;
  sign: 'charge' | 'credit';
  amountInBaseCurrency: number;
  amount: number;
  currency: {
    id: number;
    name: string;
  };
  exchangeRate: number;
  reference: string;
  scheduledDate: string | null;
  appliesToClientCode: string;
  branchId: number | null;
  deliveryReceipt: string;
  deliveryReceiptDate: string | null;
  customerOrder: string;
  internalReference: string;
  status: string;
  isCanceled: boolean;
}

export class ClientBalanceDocument {
  private constructor(private readonly props: ClientBalanceDocumentProps) {}

  static create(props: ClientBalanceDocumentProps): ClientBalanceDocument {
    return new ClientBalanceDocument(props);
  }

  toPrimitives(): ClientBalanceDocumentProps {
    return { ...this.props };
  }
}
