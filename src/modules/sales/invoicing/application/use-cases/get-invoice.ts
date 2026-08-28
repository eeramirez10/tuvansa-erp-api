import { NotFoundError } from '../../../../../shared/domain/errors/not-found-error.js';
import type { InvoicesRepository } from '../../domain/repositories/invoices-repository.js';
import { toInvoiceResponse } from '../dtos/invoice-response.js';

export class GetInvoice {
  constructor(private readonly repository: InvoicesRepository) {}
  async execute(invoiceId: number) {
    const invoice = await this.repository.findById(invoiceId);
    if (invoice === null) throw new NotFoundError('Factura');
    return toInvoiceResponse(invoice);
  }
}
