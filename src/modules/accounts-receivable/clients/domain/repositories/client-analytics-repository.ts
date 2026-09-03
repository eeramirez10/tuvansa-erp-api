import type {
  ClientAnalyticsItem,
  ClientAnalyticsSummary,
  ClientRiskLevel,
} from '../entities/client-analytics.js';

export interface ClientAnalyticsCriteria {
  query?: string;
  status: 'active' | 'inactive' | 'all';
  risk: ClientRiskLevel | 'all';
  limit: number;
  offset: number;
}

export interface ClientAnalyticsResult {
  asOf: string;
  summary: ClientAnalyticsSummary;
  items: ClientAnalyticsItem[];
  total: number;
}

export interface ClientAnalyticsRepository {
  getReport(criteria: ClientAnalyticsCriteria): Promise<ClientAnalyticsResult>;
}
