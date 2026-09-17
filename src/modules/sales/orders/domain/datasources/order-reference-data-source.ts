import type { CaptureOptions, CaptureCustomer, CaptureProduct } from '../repositories/order-capture-repository.js';

export interface OrderReferenceDataSource {
  options(): Promise<CaptureOptions>;
  customer(code: string): Promise<CaptureCustomer>;
  customerById(id: number): Promise<CaptureCustomer>;
  productCodeById(id: number): Promise<string>;
  product(code: string, warehouse: string, type: string, customerCode: string): Promise<CaptureProduct>;
  hasInvoices(number: string): Promise<boolean>;
}
