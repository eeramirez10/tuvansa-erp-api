export interface BankSupplierExpenseReceipt {
  receiptId: number;
  receiptNumber: string;
  supplierId: number;
  supplierCode: string;
  supplierName: string;
  remaining: number;
  revision: number;
  receivedAt: string;
}

export interface BankSupplierExpenseReceipts {
  writable(): boolean;
  pending(companyId: number): Promise<BankSupplierExpenseReceipt[]>;
}

export interface BankSupplierExpenseInput {
  requestKey: string;
  receiptId: number;
  supplierId: number;
  revision: number;
  amount: number;
  date: string;
  description: string;
}
