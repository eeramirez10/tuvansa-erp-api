import type { Invoice } from '../entities/invoice.js';
import type {
  InvoiceNavigationDirection,
  InvoiceSearchCriteria,
  InvoiceSearchResult,
} from '../repositories/invoices-repository.js';

export interface InvoicesDataSource {
  findById(invoiceId: number): Promise<Invoice | null>;
  findByNumber(invoiceNumber: string): Promise<Invoice | null>;
  findFirst(): Promise<Invoice | null>;
  findAdjacent(invoiceId: number, direction: InvoiceNavigationDirection): Promise<Invoice | null>;
  search(criteria: InvoiceSearchCriteria): Promise<InvoiceSearchResult>;
}
