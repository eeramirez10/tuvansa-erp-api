import type { Invoice, InvoiceProps } from '../../domain/entities/invoice.js';

export type InvoiceResponse = InvoiceProps;
export const toInvoiceResponse = (invoice: Invoice): InvoiceResponse => invoice.toPrimitives();
