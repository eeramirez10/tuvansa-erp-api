import { NotFoundError } from '../../../../../shared/domain/errors/not-found-error.js';
import type { AccountingPoliciesRepository } from '../../domain/repositories/accounting-policies-repository.js';
import { toAccountingPolicyResponse } from '../dtos/accounting-policy-response.js';

export class GetAccountingPolicyByNumber {
  constructor(private readonly repository: AccountingPoliciesRepository) {}
  async execute(number: string) {
    const result = await this.repository.findByNumber(number);
    if (result === null) throw new NotFoundError('Poliza contable');
    return toAccountingPolicyResponse(result);
  }
}
