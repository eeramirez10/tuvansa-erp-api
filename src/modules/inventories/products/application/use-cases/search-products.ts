import type { ProductsRepository } from '../../domain/repositories/products-repository.js';
import { toProductResponse, type ProductResponse } from '../dtos/product-response.js';

export interface SearchProductsInput {
  query?: string;
  status: 'active' | 'inactive' | 'all';
  page: number;
  pageSize: number;
}

export interface SearchProductsOutput {
  data: ProductResponse[];
  pagination: { page: number; pageSize: number; total: number };
}

export class SearchProducts {
  constructor(private readonly repository: ProductsRepository) {}

  async execute(input: SearchProductsInput): Promise<SearchProductsOutput> {
    const result = await this.repository.search({
      ...(input.query === undefined ? {} : { query: input.query }),
      status: input.status,
      limit: input.pageSize,
      offset: (input.page - 1) * input.pageSize,
    });
    return {
      data: result.items.map(toProductResponse),
      pagination: { page: input.page, pageSize: input.pageSize, total: result.total },
    };
  }
}
