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
export interface CaptureCustomerMatch {
  id: number; code: string; name: string; branch: string; taxId: string;
  ean: string; phone: string; mobile: string; email: string;
}
export interface CaptureCustomerSearchCriteria {
  code?: string;
  name?: string;
  taxId?: string;
}
export interface CaptureProduct {
  id: number; code: string; description: string; unit: string; price: number;
  cost: number; costCurrencyId: CaptureCurrencyId;
  taxPercentage: number; excisePercentage: number; currencyId: CaptureCurrencyId;
  stock: number; assigned: number; available: number; weight: number; volume: number;
}
export interface CaptureProductMatch {
  id: number; code: string; description: string; available: number; price: number;
  currencyId: CaptureCurrencyId;
  warehouse: string; family: string; secondaryFamily: string;
  nextReceipt: string | null; supplierCode: string;
}
export interface CaptureProductSearchCriteria {
  code?: string;
  description?: string;
  supplierCode?: string;
}
export type CaptureCurrencyId = 1 | 2;
export type CaptureCurrencyName = 'DOLARES' | 'PESOS';
export type CaptureOrderDiscounts = [number, number, number, number];
export interface CaptureLine {
  productCode: string; quantity: number; price: number; discount: number;
  currencyId?: CaptureCurrencyId | undefined;
}
export interface CaptureInput {
  warehouse: string; typeCode: string; customerCode: string; customerOrderNumber: string;
  orderedAt: string; from: string; dueAt: string; department: string; initial: boolean;
  agentCode: string; termsDays: number; store: string; observations: string;
  exchangeRate: number; boxes: number; branch: number; collectionCurrency: CaptureCurrencyName;
  orderDiscounts: CaptureOrderDiscounts;
  commission: number; noPartialDeliveries: boolean; transportation: string;
  deliveryAddress: [string, string, string]; contact: string; additionalComments: string;
  documentKind: 'order' | 'quote'; lines: CaptureLine[];
}
export interface OrderCaptureRepository {
  options(): Promise<CaptureOptions>;
  customer(code: string): Promise<CaptureCustomer>;
  searchCustomers(criteria: CaptureCustomerSearchCriteria, limit: number): Promise<CaptureCustomerMatch[]>;
  searchProducts(criteria: CaptureProductSearchCriteria, warehouse: string, limit: number): Promise<CaptureProductMatch[]>;
  product(code: string, warehouse: string, typeCode: string, customerCode: string): Promise<CaptureProduct>;
  create(input: CaptureInput): Promise<Order>;
  convertQuote(orderId: number): Promise<Order>;
  setAuthorization(orderId: number, authorized: boolean): Promise<Order>;
  setAssignment(orderId: number, lines: Array<{ lineId: number; assigned: number }>): Promise<Order>;
}
