import type { AccountingPoliciesDataSource } from '../../domain/datasources/accounting-policies-data-source.js';
import type { AccountingPolicy } from '../../domain/entities/accounting-policy.js';
import type {
  AccountingPoliciesRepository,
  AccountingPolicyClassificationsResult,
  AccountingPolicyNavigationDirection,
  AccountingPolicySearchCriteria,
  AccountingPolicySearchResult,
} from '../../domain/repositories/accounting-policies-repository.js';

export class AccountingPoliciesRepositoryImpl implements AccountingPoliciesRepository {
  constructor(private readonly dataSource: AccountingPoliciesDataSource) {}
  findById(id: number): Promise<AccountingPolicy | null> { return this.dataSource.findById(id); }
  findByNumber(number: string): Promise<AccountingPolicy | null> { return this.dataSource.findByNumber(number); }
  search(criteria: AccountingPolicySearchCriteria): Promise<AccountingPolicySearchResult> { return this.dataSource.search(criteria); }
  findAdjacent(id: number, direction: AccountingPolicyNavigationDirection): Promise<AccountingPolicy | null> { return this.dataSource.findAdjacent(id, direction); }
  getClassifications(id: number): Promise<AccountingPolicyClassificationsResult | null> { return this.dataSource.getClassifications(id); }
}
