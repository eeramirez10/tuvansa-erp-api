import type { CaptureCustomerSearchCriteria, CaptureInput, CaptureProductSearchCriteria, OrderCaptureRepository } from '../../domain/repositories/order-capture-repository.js';
import type { OrderAuthorizationAccess } from '../../domain/datasources/order-authorization-access.js';
import { toOrderResponse } from '../dtos/order-response.js';

export class CaptureOrder {
  constructor(private readonly repository: OrderCaptureRepository, private readonly authorizationAccess: OrderAuthorizationAccess) {}
  options() { return this.repository.options(); }
  customer(code: string) { return this.repository.customer(code); }
  searchCustomers(criteria: CaptureCustomerSearchCriteria, limit: number) { return this.repository.searchCustomers(criteria, limit); }
  searchProducts(criteria: CaptureProductSearchCriteria, warehouse: string, limit: number) { return this.repository.searchProducts(criteria, warehouse, limit); }
  productFamilies() { return this.repository.productFamilies(); }
  product(code: string, warehouse: string, typeCode: string, customerCode: string) { return this.repository.product(code, warehouse, typeCode, customerCode); }
  async create(input: CaptureInput) { return toOrderResponse(await this.repository.create(input)); }
  async convertQuote(id: number) { return toOrderResponse(await this.repository.convertQuote(id)); }
  async setAuthorization(id: number, input: { authorized: boolean; revision: number }, credential: string | undefined) {
    const userId = await this.authorizationAccess.verify(credential);
    return toOrderResponse(await this.repository.setAuthorization(id, { ...input, userId }));
  }
  async setAssignment(id: number, lines: Array<{ lineId: number; assigned: number }>) {
    return toOrderResponse(await this.repository.setAssignment(id, lines));
  }
}
