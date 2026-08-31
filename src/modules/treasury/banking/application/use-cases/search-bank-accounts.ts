import type { BankAccountSearchCriteria, BankAccountsRepository } from '../../domain/repositories/bank-accounts-repository.js';
import { toBankAccountResponse } from '../dtos/bank-account-response.js';

export class SearchBankAccounts {
  constructor(private readonly repository: BankAccountsRepository) {}

  async execute(criteria: Omit<BankAccountSearchCriteria, 'offset' | 'limit'> & { page: number; pageSize: number }) {
    const result = await this.repository.search({
      ...criteria,
      offset: (criteria.page - 1) * criteria.pageSize,
      limit: criteria.pageSize,
    });
    return {
      data: result.items.map(toBankAccountResponse),
      pagination: {
        page: criteria.page,
        pageSize: criteria.pageSize,
        total: result.total,
        pages: Math.ceil(result.total / criteria.pageSize),
      },
    };
  }
}
