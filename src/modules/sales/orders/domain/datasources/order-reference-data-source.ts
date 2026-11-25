import type { CaptureOptions, CaptureCustomer, CaptureCustomerMatch, CaptureCustomerSearchCriteria, CaptureProduct, CaptureProductFamily, CaptureProductMatch, CaptureProductSearchCriteria } from '../repositories/order-capture-repository.js';

export type OrderAuthorizationCost = Pick<CaptureProduct, 'cost' | 'costCurrencyId'>;

export interface OrderReferenceDataSource {
  options(): Promise<CaptureOptions>;
  customer(code: string): Promise<CaptureCustomer>;
  searchCustomers(criteria: CaptureCustomerSearchCriteria, limit: number): Promise<CaptureCustomerMatch[]>;
  searchProducts(criteria: CaptureProductSearchCriteria, warehouse: string, limit: number): Promise<CaptureProductMatch[]>;
  productFamilies(): Promise<CaptureProductFamily[]>;
  customerById(id: number): Promise<CaptureCustomer>;
  productCodeById(id: number): Promise<string>;
  product(code: string, warehouse: string, type: string, customerCode: string): Promise<CaptureProduct>;
  canAuthorizeCustomer(id: number): Promise<boolean>;
  authorizationCosts(productIds: number[]): Promise<ReadonlyMap<number, OrderAuthorizationCost>>;
  hasInvoices(number: string): Promise<boolean>;
}
