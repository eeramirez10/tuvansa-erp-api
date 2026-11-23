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

export type BankTransferMode = 'check' | 'transfer';
export type BankTransferDirection = 'incoming' | 'outgoing';

interface BankTransferFields {
  requestKey: string;
  date: string;
  amount: number;
  reference: string;
  beneficiary: string;
  description: string;
}

export type BankTransferInput = BankTransferFields & (
  | { sourceBankAccountId: number }
  | { destinationBankAccountId: number; mode: BankTransferMode }
);

export type ResolvedBankTransferInput = BankTransferFields & { sourceBankAccountId: number; mode: BankTransferMode };

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
  mode: BankTransferMode;
}

export interface BankTransferReferences {
  settings(companyId: number): Promise<BankTransferSettings | null>;
  account(id: number): Promise<BankAccountProps | null>;
  candidates(companyId: number, role: 'source' | 'destination'): Promise<BankAccountProps[]>;
  chequeExists(companyId: number, sourceAccountId: number, number: string): Promise<boolean>;
}

export interface BankTransferCommand {
  companyId: number;
  userId: number;
  destinationAccountId: number;
  input: ResolvedBankTransferInput;
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
