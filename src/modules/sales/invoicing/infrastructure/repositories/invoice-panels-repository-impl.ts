import type { InvoicePanelsDataSource } from '../../domain/datasources/invoice-panels-data-source.js';
import type {
  InvoicePanelKey,
  InvoicePanelResult,
  InvoicePanelsRepository,
} from '../../domain/repositories/invoice-panels-repository.js';

export class InvoicePanelsRepositoryImpl implements InvoicePanelsRepository {
  constructor(private readonly dataSource: InvoicePanelsDataSource) {}
  getPanel(invoiceId: number, key: InvoicePanelKey): Promise<InvoicePanelResult | null> {
    return this.dataSource.getPanel(invoiceId, key);
  }
}
