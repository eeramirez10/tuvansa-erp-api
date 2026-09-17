import type { Order } from '../entities/order.js';

export interface CaptureOptions {
  warehouses: Array<{ code: string; description: string }>;
  types: Array<{ code: string; description: string; nextNumber: string; taxPercentage: number }>;
  agents: Array<{ code: string; displayCode: string; name: string }>;
}
export interface CaptureCustomer {
  id: number; code: string; name: string; agentCode: string; agentName: string;
  termsDays: number; store: string; classification: string;
  branches: Array<{ code: number; name: string }>;
}
export interface CaptureProduct {
  id: number; code: string; description: string; unit: string; price: number;
  taxPercentage: number; excisePercentage: number; currencyId: number;
  stock: number; assigned: number; available: number; weight: number; volume: number;
}
export interface CaptureLine { productCode: string; quantity: number; price: number; discount: number }
export interface CaptureInput {
  warehouse: string; typeCode: string; customerCode: string; customerOrderNumber: string;
  orderedAt: string; from: string; dueAt: string; department: string; initial: boolean;
  agentCode: string; termsDays: number; store: string; observations: string;
  documentKind: 'order' | 'quote'; lines: CaptureLine[];
}
export interface OrderCaptureRepository {
  options(): Promise<CaptureOptions>;
  customer(code: string): Promise<CaptureCustomer>;
  product(code: string, warehouse: string, typeCode: string, customerCode: string): Promise<CaptureProduct>;
  create(input: CaptureInput): Promise<Order>;
  convertQuote(orderId: number): Promise<Order>;
}
