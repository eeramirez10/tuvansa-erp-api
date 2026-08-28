import type { Invoice } from '../entities/invoice.js';

export type InvoiceNavigationDirection = 'previous' | 'next';

export interface InvoiceSearchCriteria {
  query?: string;
  issuedAt?: string;
  invoiceNumber?: string;
  orderNumber?: string;
  customerOrderNumber?: string;
  deliveryNote?: string;
  folio?: string;
  customerCode?: string;
  warehouseSeal?: string;
  amount?: number;
  offset: number;
  limit: number;
}

export interface InvoiceSearchResult {
  items: Invoice[];
  total: number;
}

export interface InvoicesRepository {
  findById(invoiceId: number): Promise<Invoice | null>;
  findByNumber(invoiceNumber: string): Promise<Invoice | null>;
  findFirst(): Promise<Invoice | null>;
  findAdjacent(invoiceId: number, direction: InvoiceNavigationDirection): Promise<Invoice | null>;
  search(criteria: InvoiceSearchCriteria): Promise<InvoiceSearchResult>;
}
