import { NotFoundError } from '../../../../../shared/domain/errors/not-found-error.js';
import type {
  InvoicePanelKey,
  InvoicePanelsRepository,
} from '../../domain/repositories/invoice-panels-repository.js';

export class GetInvoicePanel {
  constructor(private readonly repository: InvoicePanelsRepository) {}
  async execute(invoiceId: number, key: InvoicePanelKey) {
    const result = await this.repository.getPanel(invoiceId, key);
    if (result === null) throw new NotFoundError('Factura');
    return { data: result };
  }
}
