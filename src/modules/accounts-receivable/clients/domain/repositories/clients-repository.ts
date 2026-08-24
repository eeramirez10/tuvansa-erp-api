import type { Client } from '../entities/client.js';

export interface ClientSearchCriteria {
  query?: string;
  limit: number;
  offset: number;
}

export interface ClientSearchResult {
  items: Client[];
  total: number;
}

export interface ClientsRepository {
  findByCode(clientCode: string): Promise<Client | null>;
  search(criteria: ClientSearchCriteria): Promise<ClientSearchResult>;
}
