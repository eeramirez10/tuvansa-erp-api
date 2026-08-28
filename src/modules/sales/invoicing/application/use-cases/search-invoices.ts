import type { InvoiceSearchCriteria, InvoicesRepository } from '../../domain/repositories/invoices-repository.js';
import { toInvoiceResponse } from '../dtos/invoice-response.js';

export class SearchInvoices {
  constructor(private readonly repository: InvoicesRepository) {}
  async execute(criteria: Omit<InvoiceSearchCriteria, 'offset' | 'limit'> & { page: number; pageSize: number }) {
    const { page, pageSize, ...filters } = criteria;
    const result = await this.repository.search({
      ...filters,
      offset: (page - 1) * pageSize,
      limit: pageSize,
    });
    return {
      data: result.items.map(toInvoiceResponse),
      pagination: { page, pageSize, total: result.total, pages: Math.ceil(result.total / pageSize) },
    };
  }
}
