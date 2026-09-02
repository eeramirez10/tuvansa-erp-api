import type { AccountingPoliciesRepository, AccountingPolicySearchCriteria } from '../../domain/repositories/accounting-policies-repository.js';
import { toAccountingPolicyResponse } from '../dtos/accounting-policy-response.js';

export class SearchAccountingPolicies {
  constructor(private readonly repository: AccountingPoliciesRepository) {}
  async execute(criteria: Omit<AccountingPolicySearchCriteria, 'offset' | 'limit'> & { page: number; pageSize: number }) {
    const { page, pageSize, ...filters } = criteria;
    const result = await this.repository.search({ ...filters, offset: (page - 1) * pageSize, limit: pageSize });
    return {
      data: result.items.map(toAccountingPolicyResponse),
      pagination: { page, pageSize, total: result.total, pages: Math.ceil(result.total / pageSize) },
    };
  }
}
