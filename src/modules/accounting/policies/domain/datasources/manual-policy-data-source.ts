import type { AccountingPolicyProps } from '../entities/accounting-policy.js';

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
export type ManualPolicyOperation = 'apply' | 'unapply' | 'cancel';
export type ManualPolicyLine = Omit<ManualPolicyLineInput, 'accountCode'> & { account: ManualPolicyAccount; parents: ManualPolicyAccount[] };

export interface ManualPolicyReferences {
  settings(): Promise<ManualPolicySettings | null>;
  search(query: string): Promise<ManualPolicyAccount[]>;
  accounts(codes: string[], levels: number[]): Promise<Map<string, { account: ManualPolicyAccount; parents: ManualPolicyAccount[] }>>;
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
  lines: (ManualPolicyLine & { id: number; reconciled: boolean })[];
}

export interface ManualPolicyDataSource {
  writable(): boolean;
  find(id: number): Promise<ManualPolicyDocument | null>;
  findRequest(key: string, fingerprint: string): Promise<AccountingPolicyProps | null>;
  create(input: ManualPolicyInput, lines: ManualPolicyLine[], fingerprint: string, verify: () => Promise<void>): Promise<AccountingPolicyProps>;
  change(id: number, input: ManualPolicyInput & { revision: number }, lines: ManualPolicyLine[], fingerprint: string, validate: (current: ManualPolicyDocument) => Promise<void>): Promise<AccountingPolicyProps>;
  perform(id: number, operation: ManualPolicyOperation, input: ManualPolicyActionInput, fingerprint: string,
    validate: (current: ManualPolicyDocument) => Promise<void>): Promise<AccountingPolicyProps>;
}
