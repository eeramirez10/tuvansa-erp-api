import type { BankPanelKey, BankPanelOptions, BankPanelResponse } from '../repositories/bank-panels-repository.js';

export interface BankPanelsDataSource {
  getPanel(bankAccountId: number, key: BankPanelKey, options: BankPanelOptions): Promise<BankPanelResponse>;
}
