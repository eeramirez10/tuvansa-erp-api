import { NotFoundError } from '../../../../../shared/domain/errors/not-found-error.js';
import type { SupplierPanelsRepository } from '../../domain/repositories/supplier-panels-repository.js';

export class GetSupplierClassifications {
  constructor(private readonly repository: SupplierPanelsRepository) {}

  async execute(supplierId: number, position: number) {
    const result = await this.repository.findClassifications(supplierId, position);
    if (result === null) throw new NotFoundError('Proveedor');
    return { data: result };
  }
}
