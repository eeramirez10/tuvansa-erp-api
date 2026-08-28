import type {
  InvoiceNavigationDirection,
  InvoicesRepository,
} from '../../domain/repositories/invoices-repository.js';
import { toInvoiceResponse } from '../dtos/invoice-response.js';

export class NavigateInvoice {
  constructor(private readonly repository: InvoicesRepository) {}
  async execute(invoiceId: number, direction: InvoiceNavigationDirection) {
    const invoice = await this.repository.findAdjacent(invoiceId, direction);
    return invoice === null ? null : toInvoiceResponse(invoice);
  }
}
