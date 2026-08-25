import { NotFoundError } from '../../../../../shared/domain/errors/not-found-error.js';
import type { ClientBalanceRepository } from '../../domain/repositories/client-balance-repository.js';
import {
  toClientBalanceDocumentResponse,
  type ClientBalanceDocumentResponse,
} from '../dtos/client-balance-response.js';

export interface GetClientBalanceInput {
  clientId: number;
  query?: string;
  dueStatus: 'all' | 'overdue' | 'notDue';
  page: number;
  pageSize: number;
}

export interface GetClientBalanceOutput {
  data: {
    client: {
      id: number;
      code: string;
      name: string;
      currentBalance: number;
    };
    summary: {
      totalBalance: number;
      overdueBalance: number;
      notDueBalance: number;
      documentCount: number;
      overdueDocumentCount: number;
      notDueDocumentCount: number;
    };
    documents: ClientBalanceDocumentResponse[];
  };
  pagination: {
    page: number;
    pageSize: number;
    total: number;
  };
}

export class GetClientBalance {
  constructor(private readonly balanceRepository: ClientBalanceRepository) {}

  async execute(input: GetClientBalanceInput): Promise<GetClientBalanceOutput> {
    const result = await this.balanceRepository.searchByClient({
      clientId: input.clientId,
      ...(input.query === undefined ? {} : { query: input.query }),
      dueStatus: input.dueStatus,
      limit: input.pageSize,
      offset: (input.page - 1) * input.pageSize,
    });

    if (result === null) {
      throw new NotFoundError('Cliente');
    }

    return {
      data: {
        client: result.client,
        summary: result.summary,
        documents: result.items.map(toClientBalanceDocumentResponse),
      },
      pagination: {
        page: input.page,
        pageSize: input.pageSize,
        total: result.total,
      },
    };
  }
}
