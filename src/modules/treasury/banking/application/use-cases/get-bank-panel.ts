import type { BankPanelKey, BankPanelOptions, BankPanelsRepository } from '../../domain/repositories/bank-panels-repository.js';

export class GetBankPanel {
  constructor(private readonly repository: BankPanelsRepository) {}

  execute(bankAccountId: number, key: BankPanelKey, options: BankPanelOptions) {
    return this.repository.getPanel(bankAccountId, key, options);
  }
}
