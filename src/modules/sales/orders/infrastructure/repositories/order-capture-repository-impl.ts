import type { OrderCaptureDataSource } from '../../domain/datasources/order-capture-data-source.js';
import type { CaptureInput, OrderCaptureRepository } from '../../domain/repositories/order-capture-repository.js';

export class OrderCaptureRepositoryImpl implements OrderCaptureRepository {
  constructor(private readonly source: OrderCaptureDataSource) {}
  options() { return this.source.options(); }
  customer(code: string) { return this.source.customer(code); }
  product(code: string, warehouse: string, typeCode: string, customerCode: string) { return this.source.product(code, warehouse, typeCode, customerCode); }
  create(input: CaptureInput) { return this.source.create(input); }
  convertQuote(orderId: number) { return this.source.convertQuote(orderId); }
}
