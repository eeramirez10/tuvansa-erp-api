import type { CaptureInput, OrderCaptureRepository } from '../../domain/repositories/order-capture-repository.js';
import { toOrderResponse } from '../dtos/order-response.js';

export class CaptureOrder {
  constructor(private readonly repository: OrderCaptureRepository) {}
  options() { return this.repository.options(); }
  customer(code: string) { return this.repository.customer(code); }
  searchCustomers(query: string, limit: number) { return this.repository.searchCustomers(query, limit); }
  product(code: string, warehouse: string, typeCode: string, customerCode: string) { return this.repository.product(code, warehouse, typeCode, customerCode); }
  async create(input: CaptureInput) { return toOrderResponse(await this.repository.create(input)); }
  async convertQuote(id: number) { return toOrderResponse(await this.repository.convertQuote(id)); }
  async setAuthorization(id: number, authorized: boolean) { return toOrderResponse(await this.repository.setAuthorization(id, authorized)); }
  async setAssignment(id: number, lines: Array<{ lineId: number; assigned: number }>) {
    return toOrderResponse(await this.repository.setAssignment(id, lines));
  }
}
