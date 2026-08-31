export type BankAccountSystemType = 'bank' | 'expense' | 'other';
export type BankAccountNature = 'debtor' | 'creditor';

export interface BankAccountMonthlyValues {
  month: number;
  balance: number;
  charges: number;
  credits: number;
  budget: number;
}

export interface BankAccountProps {
  id: number;
  code: string;
  family: string;
  accountNumber: string;
  branch: string;
  name: string;
  nature: BankAccountNature;
  systemType: BankAccountSystemType;
  currency: { id: number; name: string };
  balances: {
    current: number;
    bank: number;
    previous: number;
    inTransit: number;
  };
  currencyBalances: {
    current: number;
    month12: number;
    previous: number;
  };
  control: {
    manager: string;
    phone: string;
    customerNumber: string;
    controlEnabled: boolean;
    nextCheckNumber: number;
    nextDepositNumber: number;
    nextTransferNumber: number;
    subAccounts: boolean;
    preventJournalEntries: boolean;
    format: string;
    movements: boolean;
    budgetable: boolean;
    company: number;
    deposits: boolean;
    payments: boolean;
    multiCompany: number;
  };
  prorationPercentages: {
    sales: number;
    inventory: number;
    distribution: number;
    advance: number;
  };
  fiscalReports: {
    annualInflationAdjustment: number;
    deductibleIetu: boolean;
    nonDeductibleVat: boolean;
  };
  createdAt: string | null;
  ledger: {
    firstPeriod: BankAccountMonthlyValues[];
    secondPeriod: BankAccountMonthlyValues[];
  };
}

export class BankAccount {
  private constructor(private readonly props: BankAccountProps) {}

  static create(props: BankAccountProps): BankAccount {
    return new BankAccount(props);
  }

  toPrimitives(): BankAccountProps {
    return structuredClone(this.props);
  }
}
