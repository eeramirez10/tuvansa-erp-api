import type { AccountingPoliciesRepository, AccountingPolicyNavigationDirection } from '../../domain/repositories/accounting-policies-repository.js';
import { toAccountingPolicyResponse } from '../dtos/accounting-policy-response.js';

export class NavigateAccountingPolicy {
  constructor(private readonly repository: AccountingPoliciesRepository) {}
  async execute(id: number, direction: AccountingPolicyNavigationDirection) {
    const result = await this.repository.findAdjacent(id, direction);
    return result === null ? null : toAccountingPolicyResponse(result);
  }
}
