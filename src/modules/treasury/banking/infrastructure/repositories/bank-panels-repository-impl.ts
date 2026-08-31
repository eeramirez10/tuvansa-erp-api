import type { BankPanelsDataSource } from '../../domain/datasources/bank-panels-data-source.js';
import type { BankPanelKey, BankPanelOptions, BankPanelResponse, BankPanelsRepository } from '../../domain/repositories/bank-panels-repository.js';

export class BankPanelsRepositoryImpl implements BankPanelsRepository {
  constructor(private readonly dataSource: BankPanelsDataSource) {}
  getPanel(id: number, key: BankPanelKey, options: BankPanelOptions): Promise<BankPanelResponse> {
    return this.dataSource.getPanel(id, key, options);
  }
}
