import { NotFoundError } from '../../../../../shared/domain/errors/not-found-error.js';
import type { SuppliersRepository } from '../../domain/repositories/suppliers-repository.js';
import { toSupplierResponse } from '../dtos/supplier-response.js';

export class GetSupplier {
  constructor(private readonly repository: SuppliersRepository) {}

  async execute(supplierId: number) {
    const supplier = await this.repository.findById(supplierId);
    if (supplier === null) throw new NotFoundError('Proveedor');
    return toSupplierResponse(supplier);
  }
}
