import type { ManualPolicyInput, ManualPolicyLine } from '../../../../accounting/policies/domain/datasources/manual-policy-data-source.js';
import type { AccountingPolicyProps } from '../../../../accounting/policies/domain/entities/accounting-policy.js';
import type { BankReviewDocument } from '../entities/bank-review.js';

export interface BankReviewTransferInput {
  destinationBankAccountId: number;
  date: string;
  revision: number;
  movementIds: number[];
  requestKey: string;
}

export interface BankReviewTransferPosting {
  accountId: number;
  revision: number;
  marks: BankReviewDocument;
  journal: ManualPolicyInput;
  lines: ManualPolicyLine[];
  fingerprint: string;
  verify(): Promise<void>;
}

export interface BankReviewTransferDataSource {
  findRequest(requestKey: string, fingerprint: string): Promise<AccountingPolicyProps | null>;
  post(command: BankReviewTransferPosting): Promise<AccountingPolicyProps>;
}
