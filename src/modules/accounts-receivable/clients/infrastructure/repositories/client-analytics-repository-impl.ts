import type { ClientAnalyticsDataSource } from '../../domain/datasources/client-analytics-data-source.js';
import type {
  ClientAnalyticsCriteria,
  ClientAnalyticsRepository,
  ClientAnalyticsResult,
} from '../../domain/repositories/client-analytics-repository.js';

export class ClientAnalyticsRepositoryImpl implements ClientAnalyticsRepository {
  constructor(private readonly dataSource: ClientAnalyticsDataSource) {}

  getReport(criteria: ClientAnalyticsCriteria): Promise<ClientAnalyticsResult> {
    return this.dataSource.getReport(criteria);
  }
}
