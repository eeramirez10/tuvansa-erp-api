import type { ClientBalanceDocument } from '../entities/client-balance-document.js';

export interface ClientBalanceSearchCriteria {
  clientId: number;
  query?: string;
  dueStatus: 'all' | 'overdue' | 'notDue';
  limit: number;
  offset: number;
}

export interface ClientBalanceResult {
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
  items: ClientBalanceDocument[];
  total: number;
}

export interface ClientBalanceRepository {
  searchByClient(criteria: ClientBalanceSearchCriteria): Promise<ClientBalanceResult | null>;
}
