import type { ClientsRepository } from '../../domain/repositories/clients-repository.js';
import { toClientResponse, type ClientResponse } from '../dtos/client-response.js';

export interface SearchClientsInput {
  query?: string;
  status: 'active' | 'inactive' | 'all';
  page: number;
  pageSize: number;
}

export interface SearchClientsOutput {
  data: ClientResponse[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
  };
}

export class SearchClients {
  constructor(private readonly clientsRepository: ClientsRepository) {}

  async execute(input: SearchClientsInput): Promise<SearchClientsOutput> {
    const result = await this.clientsRepository.search({
      ...(input.query === undefined ? {} : { query: input.query }),
      status: input.status,
      limit: input.pageSize,
      offset: (input.page - 1) * input.pageSize,
    });

    return {
      data: result.items.map(toClientResponse),
      pagination: {
        page: input.page,
        pageSize: input.pageSize,
        total: result.total,
      },
    };
  }
}
