import { NotFoundError } from '../../../../../shared/domain/errors/not-found-error.js';
import type { SupplierNavigationDirection, SuppliersRepository } from '../../domain/repositories/suppliers-repository.js';
import { toSupplierResponse } from '../dtos/supplier-response.js';

export class NavigateSupplier {
  constructor(private readonly repository: SuppliersRepository) {}

  async execute(supplierId: number, direction: SupplierNavigationDirection) {
    if (await this.repository.findById(supplierId) === null) throw new NotFoundError('Proveedor');
    const supplier = await this.repository.findAdjacent(supplierId, direction);
    return supplier === null ? null : toSupplierResponse(supplier);
  }
}
