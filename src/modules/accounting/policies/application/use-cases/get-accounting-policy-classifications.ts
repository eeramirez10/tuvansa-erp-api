import { NotFoundError } from '../../../../../shared/domain/errors/not-found-error.js';
import type { AccountingPoliciesRepository } from '../../domain/repositories/accounting-policies-repository.js';

export class GetAccountingPolicyClassifications {
  constructor(private readonly repository: AccountingPoliciesRepository) {}
  async execute(id: number) {
    const result = await this.repository.getClassifications(id);
    if (result === null) throw new NotFoundError('Poliza contable');
    return { data: result };
  }
}
