import { ConflictError } from '../../../../../shared/domain/errors/conflict-error.js';
import type { ProductsRepository } from '../../domain/repositories/products-repository.js';
import {
  toProductCreateValues,
  type CreateProductInput,
} from '../dtos/product-mutation-input.js';
import { toProductResponse, type ProductResponse } from '../dtos/product-response.js';
import { validateProductValues } from '../services/validate-product-values.js';

export class CreateProduct {
  constructor(private readonly repository: ProductsRepository) {}

  async isCodeAvailable(code: string): Promise<boolean> {
    return !(await this.repository.codeExists(code));
  }

  async options() {
    const canWrite = await this.repository.catalogWritable?.() ?? false;
    return {
      canWrite,
      reason: canWrite ? null : 'El catálogo PostgreSQL requiere una copia conciliada de PROSCAI.',
      units: canWrite ? await this.repository.listUnits?.() ?? [] : [],
    };
  }

  async execute(input: CreateProductInput): Promise<ProductResponse> {
    if (!(await this.isCodeAvailable(input.code))) {
      throw new ConflictError('Ya existe un producto con ese codigo', 'PRODUCT_CODE_EXISTS');
    }
    const values = toProductCreateValues(input);
    await validateProductValues(this.repository, values);
    return toProductResponse(await this.repository.create(values));
  }
}
