import type { BankAccountLookup, BankAccountProps } from '../entities/bank-account.js';

export interface BankTransferAccount {
  id: number;
  code: string;
  name: string;
}

export interface BankTransferSettings {
  policyType: '3';
  fiscalStart: string;
  fiscalEnd: string;
}

export interface BankTransferInput {
  requestKey: string;
  sourceBankAccountId: number;
  date: string;
  amount: number;
  reference: string;
  beneficiary: string;
  description: string;
}

export interface BankTransferResult {
  id: number;
  number: string;
  policyNumber: string;
  source: BankTransferAccount;
  destination: BankTransferAccount;
  sourceMovementId: number;
  destinationMovementId: number;
  date: string;
  amount: number;
  reference: string;
  beneficiary: string;
  description: string;
}

export interface BankTransferReferences {
  settings(companyId: number): Promise<BankTransferSettings | null>;
  account(id: number): Promise<BankAccountProps | null>;
  sources(companyId: number): Promise<BankAccountProps[]>;
}

export interface BankTransferCommand {
  companyId: number;
  userId: number;
  destinationAccountId: number;
  input: BankTransferInput;
  fingerprint: string;
  resolvePosting(lookup?: BankAccountLookup): Promise<{
    source: BankTransferAccount;
    destination: BankTransferAccount;
    settings: BankTransferSettings;
  }>;
}

export interface BankTransferDataSource {
  writable(): boolean;
  findRequest(companyId: number, key: string, fingerprint: string): Promise<BankTransferResult | null>;
  commit(command: BankTransferCommand): Promise<BankTransferResult>;
}
