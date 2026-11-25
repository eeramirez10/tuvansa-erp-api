export interface SupplierGroupingDocument {
  id: number;
  revision: string;
}

export interface SupplierBalanceGroupingInput {
  requestKey: string;
  target: SupplierGroupingDocument;
  sources: SupplierGroupingDocument[];
}

export interface SupplierBalanceGroupingResult {
  targetId: number;
  sourceIds: number[];
  amount: number;
  remaining: number;
  date: string;
}

export interface SupplierBalanceGroupingDataSource {
  save(supplierId: number, input: SupplierBalanceGroupingInput): Promise<SupplierBalanceGroupingResult>;
}
