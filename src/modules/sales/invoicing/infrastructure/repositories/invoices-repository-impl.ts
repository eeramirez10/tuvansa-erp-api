import type { InvoicesDataSource } from '../../domain/datasources/invoices-data-source.js';
import type { Invoice } from '../../domain/entities/invoice.js';
import type {
  InvoiceNavigationDirection,
  InvoiceSearchCriteria,
  InvoiceSearchResult,
  InvoicesRepository,
} from '../../domain/repositories/invoices-repository.js';

export class InvoicesRepositoryImpl implements InvoicesRepository {
  constructor(private readonly dataSource: InvoicesDataSource) {}
  findById(invoiceId: number): Promise<Invoice | null> { return this.dataSource.findById(invoiceId); }
  findByNumber(invoiceNumber: string): Promise<Invoice | null> { return this.dataSource.findByNumber(invoiceNumber); }
  findFirst(): Promise<Invoice | null> { return this.dataSource.findFirst(); }
  findAdjacent(invoiceId: number, direction: InvoiceNavigationDirection): Promise<Invoice | null> {
    return this.dataSource.findAdjacent(invoiceId, direction);
  }
  search(criteria: InvoiceSearchCriteria): Promise<InvoiceSearchResult> {
    return this.dataSource.search(criteria);
  }
}
