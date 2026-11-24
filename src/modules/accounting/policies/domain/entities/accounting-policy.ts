export interface AccountingPolicyMovement {
  id: number;
  accountId: number;
  accountCode: string;
  accountName: string;
  debit: number;
  credit: number;
  reference: string;
  exchangeRate: number;
  costCenter: number;
  reconciled: boolean;
  accountType: number;
}

export type AccountingPolicyCommentLines = [string, string, string, string, string, string];

export interface AccountingPolicyCommentMetadata {
  cheque: string;
  report: string;
  postDate: string | null;
  origin: string;
  amountInWords: string;
  comments: AccountingPolicyCommentLines;
}

export interface AccountingPolicyProps {
  id: number;
  number: string;
  date: string | null;
  cheque: string;
  company: number;
  origin: string;
  applied: boolean;
  beneficiary: string;
  family: string;
  concept: string;
  amountInWords: string;
  userId: number;
  report: string;
  auditAt: string | null;
  postDate: string | null;
  classifications: string[];
  exchangeRate: number;
  usedAt: string | null;
  totals: { debit: number; credit: number; difference: number };
  movements: AccountingPolicyMovement[];
  comments?: AccountingPolicyCommentLines;
  manual?: { revision: number; canceled: boolean; reconciled: boolean };
}

export class AccountingPolicy {
  private constructor(private readonly props: AccountingPolicyProps) {}

  static create(props: AccountingPolicyProps): AccountingPolicy {
    return new AccountingPolicy(props);
  }

  toPrimitives(): AccountingPolicyProps {
    return structuredClone(this.props);
  }
}
