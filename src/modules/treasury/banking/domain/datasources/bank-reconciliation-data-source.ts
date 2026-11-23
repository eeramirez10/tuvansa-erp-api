export interface BankReconciliationInput {
  requestKey: string;
  movementIds: number[];
  statementDate: string;
  statementBalance: number;
  expectedBankBalance: number;
}

export interface BankReconciliationResult {
  id: number;
  movementIds: number[];
  statementDate: string;
  bankBalance: number;
  previousBankBalance: number;
  netMovement: number;
}

export interface BankReconciliationMovement {
  id: number;
  date: string;
  amount: number;
}

export interface BankReconciliationCommand {
  companyId: number;
  bankAccountId: number;
  input: BankReconciliationInput;
  fingerprint: string;
  bankOpeningBalance(): Promise<number>;
}

export interface BankReconciliationDataSource {
  writable(): boolean;
  findRequest(companyId: number, requestKey: string, fingerprint: string): Promise<BankReconciliationResult | null>;
  commit(command: BankReconciliationCommand): Promise<BankReconciliationResult>;
}
