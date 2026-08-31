import { NotFoundError } from '../../../../../shared/domain/errors/not-found-error.js';
import type {
  SupplierPanelKey,
  SupplierPanelsRepository,
} from '../../domain/repositories/supplier-panels-repository.js';

export class GetSupplierPanel {
  constructor(private readonly repository: SupplierPanelsRepository) {}

  async execute(supplierId: number, key: SupplierPanelKey) {
    const result = await this.repository.findPanel(supplierId, key);
    if (result === null) throw new NotFoundError('Proveedor');
    return { data: result };
  }
}
