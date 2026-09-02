import { NotFoundError } from '../../../../../shared/domain/errors/not-found-error.js';
import type { AccountingPoliciesRepository } from '../../domain/repositories/accounting-policies-repository.js';
import { toAccountingPolicyResponse } from '../dtos/accounting-policy-response.js';

export class GetAccountingPolicy {
  constructor(private readonly repository: AccountingPoliciesRepository) {}
  async execute(id: number) {
    const result = await this.repository.findById(id);
    if (result === null) throw new NotFoundError('Poliza contable');
    return toAccountingPolicyResponse(result);
  }
}
