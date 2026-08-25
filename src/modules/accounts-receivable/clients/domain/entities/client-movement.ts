export interface ClientMovementDocument {
  id: number;
  number: string | null;
  date: string | null;
  dueDate: string | null;
  reference: string | null;
  amount: number | null;
  currencyId: number | null;
  isCanceled: boolean | null;
}

export interface ClientMovementProps {
  id: number;
  date: string;
  movementType: {
    code: string;
    description: string;
  };
  amount: number;
  runningBalance: number;
  paymentReference: string;
  exchangeRate: number;
  policy: string;
  receiptNumber: number;
  userId: number;
  document: ClientMovementDocument | null;
}

export class ClientMovement {
  private constructor(private readonly props: ClientMovementProps) {}

  static create(props: ClientMovementProps): ClientMovement {
    return new ClientMovement(props);
  }

  toPrimitives() {
    return {
      ...this.props,
      charge: this.props.amount > 0 ? this.props.amount : 0,
      credit: this.props.amount < 0 ? Math.abs(this.props.amount) : 0,
    };
  }
}
