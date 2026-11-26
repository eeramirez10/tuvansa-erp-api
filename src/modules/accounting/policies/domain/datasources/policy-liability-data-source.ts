import type { ManualPolicyDataSource, ManualPolicyInput, ManualPolicyLine } from './manual-policy-data-source.js';
import type { AccountingPolicyProps } from '../entities/accounting-policy.js';
import type { BankAccountLookup } from '../../../../treasury/banking/domain/entities/bank-account.js';

export interface PolicyLiabilitySupplier {
  id: number;
  code: string;
  name: string;
  accountCode: string;
  terms: number;
  currency: 1 | 2;
  exchangeRate: number;
}

export interface PolicyLiabilityDraft {
  date: string;
  supplierCode: string;
  amount: number;
  reference: string;
}

export interface PolicyLiabilityCharge {
  supplier: PolicyLiabilitySupplier;
  sourceId: number;
  userId: number;
  reference: string;
  dueDate: string;
  amount: number;
  tax: number;
  subtotal: number;
}

export interface PolicyLiabilityStorage extends Pick<ManualPolicyDataSource, 'writable' | 'findRequest'> {
  createLiability(
    policy: ManualPolicyInput,
    lines: ManualPolicyLine[],
    fingerprint: string,
    verify: (lookup?: BankAccountLookup) => Promise<void>,
    source: { id: number; revision: number } | undefined,
    charge: PolicyLiabilityCharge,
  ): Promise<AccountingPolicyProps>;
}
