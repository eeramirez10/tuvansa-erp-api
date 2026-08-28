import { NotFoundError } from '../../../../../shared/domain/errors/not-found-error.js';
import type { InvoicesRepository } from '../../domain/repositories/invoices-repository.js';
import { toInvoiceResponse } from '../dtos/invoice-response.js';

export class GetInvoiceByNumber {
  constructor(private readonly repository: InvoicesRepository) {}
  async execute(invoiceNumber: string) {
    const invoice = await this.repository.findByNumber(invoiceNumber);
    if (invoice === null) throw new NotFoundError('Factura');
    return toInvoiceResponse(invoice);
  }
}
