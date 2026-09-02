import type { AccountingPolicy } from '../entities/accounting-policy.js';

export type AccountingPolicyNavigationDirection = 'previous' | 'next';

export interface AccountingPolicySearchCriteria {
  query?: string;
  number?: string;
  date?: string;
  applied?: boolean;
  family?: string;
  cheque?: string;
  offset: number;
  limit: number;
}

export interface AccountingPolicySearchResult {
  items: AccountingPolicy[];
  total: number;
}

export interface AccountingPolicyClassificationsResult {
  policy: { id: number; number: string };
  key: 'classifications';
  section: 'actions';
  button: 'Clasificar';
  source: 'mysql';
  items: Array<Record<string, unknown>>;
  summary: { current: string[] };
}

export interface AccountingPoliciesRepository {
  findById(id: number): Promise<AccountingPolicy | null>;
  findByNumber(number: string): Promise<AccountingPolicy | null>;
  search(criteria: AccountingPolicySearchCriteria): Promise<AccountingPolicySearchResult>;
  findAdjacent(id: number, direction: AccountingPolicyNavigationDirection): Promise<AccountingPolicy | null>;
  getClassifications(id: number): Promise<AccountingPolicyClassificationsResult | null>;
}
