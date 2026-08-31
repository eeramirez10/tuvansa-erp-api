import type {
  SupplierClassificationResult,
  SupplierPanelKey,
  SupplierPanelResult,
} from '../repositories/supplier-panels-repository.js';

export interface SupplierPanelsDataSource {
  findPanel(supplierId: number, key: SupplierPanelKey): Promise<SupplierPanelResult | null>;
  findClassifications(supplierId: number, position: number): Promise<SupplierClassificationResult | null>;
}
