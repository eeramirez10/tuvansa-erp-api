import type { PurchaseOrder, PurchaseOrderLine, PurchaseOrderProps } from '../entities/purchase-order.js';
import type { PurchaseOrderIdentity } from '../repositories/purchase-orders-repository.js';

export interface PurchaseOrderEditRules {
  companyId: number;
  activeCompanyId: number;
  priceLocked: boolean;
  supplierUnits: boolean;
  validateSupplier: boolean;
  currencyId: number;
  currencyName: string;
  supplierCode: string;
  supplierDiscounts: [number, number];
}

export interface PurchaseOrderEditProduct {
  id: number;
  code: string;
  description: string;
  supplierCode: string;
  supplierProductCode: string;
  inactive: boolean;
  taxable: boolean;
  exciseTaxPercentage?: number;
  currencyId: number;
  currencyName: string;
  cost: number;
  dollarCost: number;
  secondaryUnit: string;
  units: Array<{ code: string; factor: number }>;
}

export interface PurchaseOrderEditLine {
  id: number | null;
  productCode: string;
  quantity: number;
  unit: string;
  discount: number;
  price: number;
  branch: number;
  pieces: string;
}

export interface PurchaseOrderEditInput {
  revision: number;
  legacyVersion: string;
  removeZero: boolean;
  lines: PurchaseOrderEditLine[];
}

export interface PurchaseOrderEditSnapshot extends PurchaseOrderIdentity {
  revision: number;
  legacyVersion: string;
  lines: PurchaseOrderLine[];
  totals: PurchaseOrderProps['totals'];
  amountInWords: string | null;
}

export type PurchaseOrderStockChange = {
  productId: number;
  pending: number;
  nextReceiptAt: string | null;
};

export interface PurchaseOrderEditLegacyDataSource {
  findById(id: number): Promise<PurchaseOrder | null>;
  rules(id: number): Promise<PurchaseOrderEditRules | null>;
  findProducts(codes: string[], supplierUnits: boolean): Promise<PurchaseOrderEditProduct[]>;
  searchProducts(query: string, supplierUnits: boolean): Promise<PurchaseOrderEditProduct[]>;
}

export interface PurchaseOrderEditStorage {
  writable(): boolean;
  findRemoved(ids?: number[]): Promise<PurchaseOrderIdentity[]>;
  find(ids: number[]): Promise<PurchaseOrderEditSnapshot[]>;
  save(snapshot: PurchaseOrderEditSnapshot, stock: PurchaseOrderStockChange[], supplierRevision: number): Promise<PurchaseOrderEditSnapshot>;
}
