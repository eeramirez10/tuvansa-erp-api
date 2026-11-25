import type { InvoiceProps } from '../entities/invoice.js';

export interface SalesTicketConversionResult {
  invoiceId: number;
  sourceNumber: string;
  number: string;
  issuedAt: string;
}

export interface SalesTicketConversionPreview {
  sourceNumber: string;
  targetType: 'FE';
  total: number;
  balance: number;
  currency: string;
  version: string | null;
  result: SalesTicketConversionResult | null;
}

export interface SalesTicketConversionInput {
  expectedVersion: string;
  requestKey: string;
}

export interface SalesTicketConversionSource {
  invoice: InvoiceProps;
  charge: number;
  paid: number;
  paymentRevision: number;
  canceled: boolean;
  result: SalesTicketConversionResult | null;
}

export interface SalesTicketConversionDataSource {
  source(invoiceId: number): Promise<SalesTicketConversionSource | null>;
  convert(
    invoiceId: number,
    requestKey: string,
    fingerprint: string,
    prepare: (source: SalesTicketConversionSource) => Promise<string>,
  ): Promise<SalesTicketConversionResult>;
}
