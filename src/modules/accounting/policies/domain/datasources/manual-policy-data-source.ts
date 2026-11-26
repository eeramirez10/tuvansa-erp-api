import type { AccountingPolicyCommentMetadata, AccountingPolicyProps } from '../entities/accounting-policy.js';
import type { BankAccountLookup, BankAccountProps } from '../../../../treasury/banking/domain/entities/bank-account.js';

export interface ManualPolicyAccount {
  id: number;
  code: string;
  name: string;
  type: number;
  nature: number;
}

export interface ManualPolicySettings {
  fiscalStart: string;
  fiscalEnd: string;
  periodYear: number;
  levels: number[];
  costCenters: { code: number; name: string }[];
}

export interface ManualPolicyLineInput {
  accountCode: string;
  costCenter: number;
  debit: number;
  credit: number;
  reference: string;
}

export interface ManualPolicyInput {
  requestKey: string;
  date: string;
  concept: string;
  beneficiary: string;
  family: string;
  lines: ManualPolicyLineInput[];
}

export interface ManualPolicyActionInput { requestKey: string; revision: number; confirmed: true }
export interface DuplicatePolicyInput { requestKey: string; date: string; revision: string; confirmed: true }
export interface ManualPolicyCommentsInput {
  requestKey: string;
  revision: number;
  fields: AccountingPolicyCommentMetadata & Pick<ManualPolicyInput, 'date' | 'concept' | 'beneficiary' | 'family'>;
}
export type ManualPolicyOperation = 'apply' | 'unapply' | 'cancel';
export type ManualPolicyLine = Omit<ManualPolicyLineInput, 'accountCode'> & {
  account: ManualPolicyAccount;
  parents: ManualPolicyAccount[];
  bankMovementType?: string;
  bankSourceMovementId?: number;
  historicalMovementId?: number;
};

export interface ManualPolicyReferences {
  settings(): Promise<ManualPolicySettings | null>;
  search(query: string): Promise<ManualPolicyAccount[]>;
  accounts(codes: string[], levels: number[], lookup?: (code: string) => Promise<BankAccountProps | null>):
    Promise<Map<string, { account: ManualPolicyAccount; parents: ManualPolicyAccount[] }>>;
}

export interface ManualPolicyDocument {
  id: number;
  number: string;
  date: string;
  concept: string;
  beneficiary: string;
  family: string;
  revision: number;
  applied: boolean;
  canceled: boolean;
  reconciled: boolean;
  updatedAt: string;
  commentMetadata: AccountingPolicyCommentMetadata | null;
  lines: (ManualPolicyLine & { id: number; reconciled: boolean })[];
}

export interface ManualPolicyDataSource {
  hasLiability?(id: number): Promise<boolean>;
  writable(): boolean;
  find(id: number): Promise<ManualPolicyDocument | null>;
  historicalApplied(id: number): Promise<boolean>;
  applyHistorical(policy: AccountingPolicyProps & { date: string }, requestKey: string, lines: ManualPolicyLine[],
    fingerprint: string, verify: (lookup?: BankAccountLookup) => Promise<void>): Promise<AccountingPolicyProps>;
  findRequest(key: string, fingerprint: string): Promise<AccountingPolicyProps | null>;
  create(input: ManualPolicyInput, lines: ManualPolicyLine[], fingerprint: string, verify: () => Promise<void>,
    source?: { id: number; revision: number }): Promise<AccountingPolicyProps>;
  change(id: number, input: ManualPolicyInput & { revision: number }, lines: ManualPolicyLine[], fingerprint: string, validate: (current: ManualPolicyDocument) => Promise<void>): Promise<AccountingPolicyProps>;
  changeComments(id: number, input: ManualPolicyCommentsInput, fingerprint: string,
    validate: (current: ManualPolicyDocument) => void): Promise<AccountingPolicyProps>;
  perform(id: number, operation: ManualPolicyOperation, input: ManualPolicyActionInput, fingerprint: string,
    validate: (current: ManualPolicyDocument) => Promise<void>): Promise<AccountingPolicyProps>;
}
