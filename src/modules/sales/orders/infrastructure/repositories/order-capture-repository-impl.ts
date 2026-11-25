import type { OrderCaptureDataSource } from '../../domain/datasources/order-capture-data-source.js';
import type { CaptureCustomerSearchCriteria, CaptureInput, CaptureProductSearchCriteria, OrderCaptureRepository } from '../../domain/repositories/order-capture-repository.js';

export class OrderCaptureRepositoryImpl implements OrderCaptureRepository {
  constructor(private readonly source: OrderCaptureDataSource) {}
  options() { return this.source.options(); }
  customer(code: string) { return this.source.customer(code); }
  searchCustomers(criteria: CaptureCustomerSearchCriteria, limit: number) { return this.source.searchCustomers(criteria, limit); }
  searchProducts(criteria: CaptureProductSearchCriteria, warehouse: string, limit: number) { return this.source.searchProducts(criteria, warehouse, limit); }
  productFamilies() { return this.source.productFamilies(); }
  product(code: string, warehouse: string, typeCode: string, customerCode: string) { return this.source.product(code, warehouse, typeCode, customerCode); }
  create(input: CaptureInput) { return this.source.create(input); }
  convertQuote(orderId: number) { return this.source.convertQuote(orderId); }
  setAuthorization(orderId: number, command: Parameters<OrderCaptureRepository['setAuthorization']>[1]) {
    return this.source.setAuthorization(orderId, command);
  }
  setAssignment(orderId: number, lines: Array<{ lineId: number; assigned: number }>) {
    return this.source.setAssignment(orderId, lines);
  }
}
