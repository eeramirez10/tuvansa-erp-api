import type { BankAccountLookup } from '../../../../treasury/banking/domain/entities/bank-account.js';
import type { ClientCatalogRecord } from '../entities/client-catalog.js';

export interface CustomerCollectionIdentity {
  companyId: number;
  clientId: number;
  remissionId: number;
}

export interface CustomerCollectionInput {
  requestKey: string;
  revision: number;
  bankAccountId: number;
  amount: number;
  date: string;
  description: string;
  reference: string;
}

export interface CustomerCollectionResult {
  id: number;
  remissionId: number;
  remissionNumber: string;
  number: string;
  receiptNumber: number;
  bankAccountId: number;
  amount: number;
  date: string;
  policyNumber: string;
  remaining: number;
}

export interface CustomerCollectionTarget {
  remissionId: number;
  number: string;
  issuedAt: string;
  movementType: string;
  canceled: boolean;
  principal: number;
  currencyId: number;
  exchangeRate: number;
  remaining: number;
  revision: number;
  lastReversalDate?: string | null;
}

export interface CustomerCollectionBank {
  id: number;
  code: string;
  name: string;
}

export interface CustomerCollectionSettings {
  policyType: string;
  fiscalStart: string;
  fiscalEnd: string;
  clientAccount: string;
  clientAccountName: string;
  bankAccounts: CustomerCollectionBank[];
}

export interface CustomerCollectionReferences {
  settings(companyId: number, clientId: number, bankAccountId?: number, lookup?: BankAccountLookup,
    catalog?: ClientCatalogRecord | null): Promise<CustomerCollectionSettings | null>;
}

export interface CustomerCollectionCommand {
  identity: CustomerCollectionIdentity;
  userId: number;
  input: CustomerCollectionInput;
  fingerprint: string;
  resolvePosting(lookup?: BankAccountLookup, catalog?: ClientCatalogRecord | null): Promise<{
    bank: CustomerCollectionBank;
    clientAccount: string;
    clientAccountName: string;
    policyType: string;
  }>;
}

export interface CustomerCollectionDataSource {
  writable(): boolean;
  target(identity: CustomerCollectionIdentity): Promise<CustomerCollectionTarget | null>;
  findRequest(companyId: number, requestKey: string, fingerprint: string): Promise<CustomerCollectionResult | null>;
  commit(command: CustomerCollectionCommand): Promise<CustomerCollectionResult>;
}
