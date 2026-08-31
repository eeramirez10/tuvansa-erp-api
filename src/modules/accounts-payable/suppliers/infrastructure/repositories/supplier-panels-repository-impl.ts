import type { SupplierPanelsDataSource } from '../../domain/datasources/supplier-panels-data-source.js';
import type {
  SupplierClassificationResult,
  SupplierPanelKey,
  SupplierPanelResult,
  SupplierPanelsRepository,
} from '../../domain/repositories/supplier-panels-repository.js';

export class SupplierPanelsRepositoryImpl implements SupplierPanelsRepository {
  constructor(private readonly dataSource: SupplierPanelsDataSource) {}
  findPanel(id: number, key: SupplierPanelKey): Promise<SupplierPanelResult | null> {
    return this.dataSource.findPanel(id, key);
  }
  findClassifications(id: number, position: number): Promise<SupplierClassificationResult | null> {
    return this.dataSource.findClassifications(id, position);
  }
}
