import type { Client } from '../entities/client.js';

export interface ClientSearchCriteria {
  query?: string;
  status: 'active' | 'inactive' | 'all';
  limit: number;
  offset: number;
}

export interface ClientSearchResult {
  items: Client[];
  total: number;
}

export interface ClientsRepository {
  findById(clientId: number): Promise<Client | null>;
  search(criteria: ClientSearchCriteria): Promise<ClientSearchResult>;
}
