import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import { NotFoundError } from '../../../../../shared/domain/errors/not-found-error.js';
import type { BankPanelsDataSource } from '../../domain/datasources/bank-panels-data-source.js';
import type { BankPanelSettingsDataSource } from '../../domain/datasources/bank-panel-settings-data-source.js';
import type { BankPanelOptions } from '../../domain/repositories/bank-panels-repository.js';
import { bankCents } from '../../domain/entities/bank-reconciliation.js';

export class ConfigureBankPanels {
  constructor(
    private readonly panels: BankPanelsDataSource,
    private readonly settings: BankPanelSettingsDataSource,
  ) {}

  async classify(accountId: number, revision: number, values: string[], options: BankPanelOptions) {
    const panel = await this.panels.getPanel(accountId, 'classifiers', options);
    if (!panel.available) throw new NotFoundError('Cuenta');
    const groups = panel.items as { value?: string; items: { code: string }[] }[];
    for (const [index, value] of values.entries()) {
      const group = groups[index];
      if (!group || (value !== '' && value !== group.value && !group.items.some(({ code }) => code === value))) {
        throw new ApplicationError('Selecciona un clasificador del catálogo de la cuenta.', 'BANK_CLASSIFIER_INVALID', 422);
      }
    }
    return this.settings.save({ accountId, action: 'classifiers', scope: '' }, revision, values);
  }

  async changeBudget(accountId: number, revision: number, values: number[], options: BankPanelOptions, costCenter = '') {
    const key = costCenter ? 'cost-center-ledger' : 'general-ledger';
    const panel = await this.panels.getPanel(accountId, key, { ...options, ...(costCenter ? { costCenter } : {}) });
    if (!panel.available) throw new NotFoundError('Cuenta');
    if (costCenter && !panel.summary?.budgetEditable) {
      throw new ApplicationError('Selecciona un centro de costos habilitado.', 'BANK_BUDGET_CENTER_INVALID', 422);
    }
    for (const amount of values) bankCents(amount);
    return this.settings.save({ accountId, action: 'budget', scope: costCenter }, revision, values);
  }

  async review(accountId: number, revision: number, ids: number[], options: BankPanelOptions) {
    const panel = await this.panels.getPanel(accountId, 'authorization-review', options);
    if (!panel.available) throw new NotFoundError('Cuenta');
    const movements = new Map((panel.items as { movementId: number; canReview?: boolean; reviewed?: boolean }[])
      .map((row) => [row.movementId, row]));
    if (ids.some((id) => !movements.get(id)?.canReview && !movements.get(id)?.reviewed)) {
      throw new ApplicationError('Selecciona movimientos web aplicados de esta cuenta.', 'BANK_REVIEW_MOVEMENT_INVALID', 422);
    }
    const key = { accountId, action: 'review' as const, scope: '' };
    const previous = (await this.settings.read<number[]>(key))?.values ?? [];
    const values = [...new Set([...previous, ...ids])].sort((left, right) => left - right);
    return this.settings.save(key, revision, values);
  }
}
