import type { BankAccountLookup } from '../entities/bank-account.js';

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

interface BankReconciliationAccountCommand {
  companyId: number;
  bankAccountId: number;
  bankOpeningBalance(lookup?: BankAccountLookup): Promise<number>;
}

export interface BankReconciliationCommand extends BankReconciliationAccountCommand {
  input: BankReconciliationInput;
  fingerprint: string;
}

export interface BankTransitInput {
  movementId: number;
  inTransit: boolean;
}

export interface BankTransitCommand extends BankReconciliationAccountCommand {
  input: BankTransitInput;
}

export interface BankPostdateInput {
  movementId: number;
  policyId: number;
  revision: number;
  postDate: string | null;
  requestKey: string;
}

export interface BankPostdateResult {
  policyId: number;
  revision: number;
  postDate: string | null;
}

export interface BankPostdateCommand extends BankReconciliationAccountCommand {
  input: BankPostdateInput;
}

export interface BankReconciliationDataSource {
  writable(): boolean;
  findRequest(companyId: number, requestKey: string, fingerprint: string): Promise<BankReconciliationResult | null>;
  commit(command: BankReconciliationCommand): Promise<BankReconciliationResult>;
  setTransit(command: BankTransitCommand): Promise<BankTransitInput>;
  setPostdate(command: BankPostdateCommand): Promise<BankPostdateResult>;
}
