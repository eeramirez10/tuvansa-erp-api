import type { CaptureOptions, CaptureCustomer, CaptureCustomerMatch, CaptureCustomerSearchCriteria, CaptureProduct } from '../repositories/order-capture-repository.js';

export interface OrderReferenceDataSource {
  options(): Promise<CaptureOptions>;
  customer(code: string): Promise<CaptureCustomer>;
  searchCustomers(criteria: CaptureCustomerSearchCriteria, limit: number): Promise<CaptureCustomerMatch[]>;
  customerById(id: number): Promise<CaptureCustomer>;
  productCodeById(id: number): Promise<string>;
  product(code: string, warehouse: string, type: string, customerCode: string): Promise<CaptureProduct>;
  hasInvoices(number: string): Promise<boolean>;
}
