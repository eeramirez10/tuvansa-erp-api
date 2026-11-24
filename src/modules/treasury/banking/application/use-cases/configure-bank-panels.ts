import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import { NotFoundError } from '../../../../../shared/domain/errors/not-found-error.js';
import type { BankPanelsDataSource } from '../../domain/datasources/bank-panels-data-source.js';
import type { BankPanelSettingsDataSource } from '../../domain/datasources/bank-panel-settings-data-source.js';
import type { BankPanelOptions } from '../../domain/repositories/bank-panels-repository.js';
import { bankCents } from '../../domain/entities/bank-reconciliation.js';
import { bankReviewMarks, type BankReviewDocument, type BankReviewMark, type BankReviewRow } from '../../domain/entities/bank-review.js';

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

  async review(accountId: number, revision: number, ids: number[], options: BankPanelOptions, mark: BankReviewMark = '*') {
    const panel = await this.panels.getPanel(accountId, 'authorization-review', options);
    if (!panel.available) throw new NotFoundError('Cuenta');
    const eligible = new Set((panel.items as BankReviewRow[]).filter((row) => row.canSetReviewMark === true && (row.reviewed !== true || mark === '*'))
      .map((row) => row.movementId));
    if (ids.some((id) => !eligible.has(id))) {
      throw new ApplicationError('Selecciona movimientos disponibles de esta cuenta.', 'BANK_REVIEW_MOVEMENT_INVALID', 422);
    }
    const key = { accountId, action: 'review' as const, scope: '' };
    const previous = bankReviewMarks((await this.settings.read<BankReviewDocument | number[]>(key))?.values);
    const values = { ...previous };
    for (const id of ids) values[id] = mark;
    const saved = await this.settings.save(key, revision, values);
    return { revision: saved.revision, values: Object.keys(saved.values).filter((id) => saved.values[id] === '*').map(Number) };
  }
}
