import type { AccountingPolicy } from '../entities/accounting-policy.js';
import type {
  AccountingPolicyClassificationsResult,
  AccountingPolicyNavigationDirection,
  AccountingPolicySearchCriteria,
  AccountingPolicySearchResult,
} from '../repositories/accounting-policies-repository.js';

export interface AccountingPoliciesDataSource {
  findById(id: number): Promise<AccountingPolicy | null>;
  findByNumber(number: string): Promise<AccountingPolicy | null>;
  search(criteria: AccountingPolicySearchCriteria): Promise<AccountingPolicySearchResult>;
  findAdjacent(id: number, direction: AccountingPolicyNavigationDirection): Promise<AccountingPolicy | null>;
  getClassifications(id: number): Promise<AccountingPolicyClassificationsResult | null>;
}
