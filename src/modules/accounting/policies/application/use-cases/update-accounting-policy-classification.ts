import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import { NotFoundError } from '../../../../../shared/domain/errors/not-found-error.js';
import type { PolicyClassificationsStorage, PolicyClassificationUpdate } from '../../domain/datasources/policy-classifications-storage.js';
import type { AccountingPoliciesRepository } from '../../domain/repositories/accounting-policies-repository.js';

export class UpdateAccountingPolicyClassification {
  constructor(
    private readonly repository: AccountingPoliciesRepository,
    private readonly storage: PolicyClassificationsStorage,
  ) {}

  async execute(id: number, input: PolicyClassificationUpdate) {
    const panel = await this.repository.getClassifications(id);
    if (!panel) throw new NotFoundError('Póliza contable');
    if (!panel.summary.canWrite) {
      throw new ApplicationError(panel.summary.reason ?? 'El clasificador es de consulta.', 'POLICY_CLASSIFICATIONS_READ_ONLY', 409);
    }
    if (!panel.items.some(({ compositeCode }) => compositeCode === input.compositeCode)) {
      throw new ApplicationError('Selecciona un clasificador del catálogo de pólizas.', 'INVALID_POLICY_CLASSIFIER', 422);
    }
    return { data: await this.storage.save(panel.policy, input) };
  }
}
