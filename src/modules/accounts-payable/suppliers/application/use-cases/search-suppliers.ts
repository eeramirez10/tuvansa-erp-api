import type { SuppliersRepository } from '../../domain/repositories/suppliers-repository.js';
import { toSupplierResponse } from '../dtos/supplier-response.js';

export interface SearchSuppliersInput {
  query?: string;
  status: 'active' | 'inactive' | 'all';
  page: number;
  pageSize: number;
}

export class SearchSuppliers {
  constructor(private readonly repository: SuppliersRepository) {}

  async execute(input: SearchSuppliersInput) {
    const result = await this.repository.search({
      ...(input.query === undefined ? {} : { query: input.query }),
      status: input.status,
      limit: input.pageSize,
      offset: (input.page - 1) * input.pageSize,
    });
    return {
      data: result.items.map(toSupplierResponse),
      pagination: { page: input.page, pageSize: input.pageSize, total: result.total },
    };
  }
}
