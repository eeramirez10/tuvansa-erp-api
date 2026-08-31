import type { PurchaseReceptionSearchCriteria, PurchaseReceptionsRepository } from '../../domain/repositories/purchase-receptions-repository.js';
import { toPurchaseReceptionResponse } from '../dtos/purchase-reception-response.js';

export class SearchPurchaseReceptions {
  constructor(private readonly repository: PurchaseReceptionsRepository) {}
  async execute(criteria: Omit<PurchaseReceptionSearchCriteria, 'offset' | 'limit'> & { page: number; pageSize: number }) {
    const { page, pageSize, ...filters } = criteria;
    const result = await this.repository.search({ ...filters, offset: (page - 1) * pageSize, limit: pageSize });
    return {
      data: result.items.map(toPurchaseReceptionResponse),
      pagination: { page, pageSize, total: result.total, pages: Math.ceil(result.total / pageSize) },
    };
  }
}
