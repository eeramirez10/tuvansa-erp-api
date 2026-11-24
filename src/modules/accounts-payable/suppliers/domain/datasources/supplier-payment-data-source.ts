import type { BankAccountLookup } from '../../../../treasury/banking/domain/entities/bank-account.js';

export type SupplierPaymentMode = 'transfer' | 'check';

export interface SupplierPaymentInput {
  requestKey: string;
  revision: number;
  bankAccountId: number;
  mode: SupplierPaymentMode;
  amount: number;
  date: string;
  description: string;
}

export interface SupplierPaymentResult {
  id: number;
  receiptId: number;
  receiptNumber: string;
  number: string;
  bankAccountId: number;
  mode: SupplierPaymentMode;
  amount: number;
  date: string;
  policyNumber: string;
  remaining: number;
}

export interface SupplierPaymentTarget {
  receiptId: number;
  number: string;
  receivedAt: string | null;
  latestReversalDate?: string | null;
  cancelled: boolean;
  principal: number;
  currencyId: number;
  exchangeRate: number;
  remaining: number;
  revision: number;
  liability?: SupplierPaymentLiability | null;
}

export interface SupplierPaymentLiability { code: string; name: string }

export interface SupplierPaymentBank {
  id: number;
  code: string;
  name: string;
}

export interface SupplierPaymentSettings {
  policyType: string;
  supplierAccount: string;
  supplierAccountName: string;
  bankAccounts: SupplierPaymentBank[];
}

export interface SupplierPaymentCatalogTerms { accountCode: string; intercompany: number }

export interface SupplierPaymentReferences {
  settings(companyId: number, supplierId: number, selectedBankId?: number, lookup?: BankAccountLookup,
    liability?: SupplierPaymentLiability | null, catalog?: SupplierPaymentCatalogTerms | null): Promise<SupplierPaymentSettings | null>;
}

export interface SupplierPaymentIdentity {
  companyId: number;
  supplierId: number;
  receiptId: number;
}

export interface SupplierPaymentCommand {
  identity: SupplierPaymentIdentity;
  userId: number;
  input: SupplierPaymentInput;
  fingerprint: string;
  resolvePosting(lookup?: BankAccountLookup, catalog?: SupplierPaymentCatalogTerms | null): Promise<{
    policyType: string;
    supplierAccount: string;
    supplierAccountName: string;
    bank: SupplierPaymentBank;
  }>;
}

export interface SupplierPaymentDataSource {
  writable(): boolean;
  target(identity: SupplierPaymentIdentity): Promise<SupplierPaymentTarget | null>;
  findRequest(companyId: number, requestKey: string, fingerprint: string): Promise<SupplierPaymentResult | null>;
  commit(command: SupplierPaymentCommand): Promise<SupplierPaymentResult>;
}
