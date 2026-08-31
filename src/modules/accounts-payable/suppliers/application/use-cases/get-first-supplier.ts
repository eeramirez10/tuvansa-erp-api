import { NotFoundError } from '../../../../../shared/domain/errors/not-found-error.js';
import type { SuppliersRepository } from '../../domain/repositories/suppliers-repository.js';
import { toSupplierResponse } from '../dtos/supplier-response.js';

export class GetFirstSupplier {
  constructor(private readonly repository: SuppliersRepository) {}

  async execute() {
    const supplier = await this.repository.findFirst();
    if (supplier === null) throw new NotFoundError('Proveedor');
    return toSupplierResponse(supplier);
  }
}
