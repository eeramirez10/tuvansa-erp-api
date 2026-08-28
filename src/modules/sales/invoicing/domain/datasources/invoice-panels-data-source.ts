import type {
  InvoicePanelKey,
  InvoicePanelResult,
} from '../repositories/invoice-panels-repository.js';

export interface InvoicePanelsDataSource {
  getPanel(invoiceId: number, key: InvoicePanelKey): Promise<InvoicePanelResult | null>;
}
