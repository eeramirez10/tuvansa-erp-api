import type { ClientRiskLevel } from '../../domain/entities/client-analytics.js';
import type { ClientAnalyticsRepository } from '../../domain/repositories/client-analytics-repository.js';

export interface GetClientAnalyticsInput {
  query?: string;
  status: 'active' | 'inactive' | 'all';
  risk: ClientRiskLevel | 'all';
  page: number;
  pageSize: number;
}

export class GetClientAnalytics {
  constructor(private readonly repository: ClientAnalyticsRepository) {}

  async execute(input: GetClientAnalyticsInput) {
    const result = await this.repository.getReport({
      ...(input.query === undefined ? {} : { query: input.query }),
      status: input.status,
      risk: input.risk,
      limit: input.pageSize,
      offset: (input.page - 1) * input.pageSize,
    });

    return {
      data: {
        scope: { branchCode: '01', branchName: 'MÉXICO', asOf: result.asOf },
        summary: result.summary,
        clients: result.items,
      },
      pagination: {
        page: input.page,
        pageSize: input.pageSize,
        total: result.total,
      },
    };
  }
}
