export interface ClientProps {
  code: string;
  name: string;
  legalName: string | null;
  taxId: string | null;
  isActive: boolean;
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
