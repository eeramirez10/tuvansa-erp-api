import type { InvoicesRepository } from '../../domain/repositories/invoices-repository.js';
import { toInvoiceResponse } from '../dtos/invoice-response.js';

export class GetFirstInvoice {
  constructor(private readonly repository: InvoicesRepository) {}
  async execute() {
    const invoice = await this.repository.findFirst();
    return invoice === null ? null : toInvoiceResponse(invoice);
  }
}
