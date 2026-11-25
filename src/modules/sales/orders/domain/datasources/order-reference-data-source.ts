import type { CaptureOptions, CaptureCustomer, CaptureCustomerMatch, CaptureCustomerSearchCriteria, CaptureProduct, CaptureProductFamily, CaptureProductMatch, CaptureProductSearchCriteria } from '../repositories/order-capture-repository.js';

export interface OrderReferenceDataSource {
  options(): Promise<CaptureOptions>;
  customer(code: string): Promise<CaptureCustomer>;
  searchCustomers(criteria: CaptureCustomerSearchCriteria, limit: number): Promise<CaptureCustomerMatch[]>;
  searchProducts(criteria: CaptureProductSearchCriteria, warehouse: string, limit: number): Promise<CaptureProductMatch[]>;
  productFamilies(): Promise<CaptureProductFamily[]>;
  customerById(id: number): Promise<CaptureCustomer>;
  productCodeById(id: number): Promise<string>;
  product(code: string, warehouse: string, type: string, customerCode: string): Promise<CaptureProduct>;
  hasInvoices(number: string): Promise<boolean>;
}
