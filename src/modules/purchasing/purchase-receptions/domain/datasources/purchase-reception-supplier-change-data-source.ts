export interface ReceiptSupplier {
  id: number;
  code: string;
  name: string;
}

export interface HistoricalReceiptSupplierCharge {
  id: number;
  date: string;
  dueAt: string | null;
  supplierReference: string;
  orderNumber: string;
  policyNumber: string;
  userId: number;
}

export interface ReceiptSupplierChange {
  receiptId: number;
  receiptNumber: string;
  originalSupplierId: number;
  supplier: ReceiptSupplier;
  supplierAccount: string;
  amount: number;
  historical: boolean;
  charge: HistoricalReceiptSupplierCharge | null;
  revision: number;
}

export interface ReceiptSupplierChangePreview {
  reception: { id: number; number: string };
  supplier: ReceiptSupplier;
  canWrite: boolean;
  reason: string | null;
  revision: string;
}

export interface ReceiptSupplierChangeSource {
  reception: { id: number; number: string };
  originalSupplier: ReceiptSupplier;
  supplierAccount: string;
  amount: number;
  historicalCharge: HistoricalReceiptSupplierCharge | null;
  reason: string | null;
  version: string;
}

export interface ReceiptSupplierReplacement extends ReceiptSupplier {
  account: string;
  eligible: boolean;
}

export interface ReceiptSupplierSearch {
  code?: string;
  name?: string;
}

export interface PurchaseReceptionSupplierChangeDataSource {
  preview(companyId: number, receiptId: number): Promise<ReceiptSupplierChangePreview | null>;
  search(companyId: number, receiptId: number, filters: ReceiptSupplierSearch): Promise<ReceiptSupplier[]>;
  save(companyId: number, receiptId: number, input: { revision: string; supplierCode: string }): Promise<ReceiptSupplierChangePreview>;
}
