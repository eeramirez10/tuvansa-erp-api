import { describe, expect, it } from 'vitest';
import { GetClientAnalytics } from '../src/modules/accounts-receivable/clients/application/use-cases/get-client-analytics.js';
import type { ClientAnalyticsRepository } from '../src/modules/accounts-receivable/clients/domain/repositories/client-analytics-repository.js';

describe('GetClientAnalytics', () => {
  it('fija el alcance de sucursal 01 Mexico y pagina el resultado', async () => {
    const repository: ClientAnalyticsRepository = {
      getReport: async () => ({
        asOf: '2026-09-03',
        summary: {
          clientCount: 1,
          activeClientCount: 1,
          creditLimit: 1000,
          totalBalance: 250,
          overdueBalance: 100,
          notDueBalance: 150,
          overdueDocumentCount: 1,
          openOrderCount: 2,
          openOrderAmount: 300,
          aging: { notDue: 150, days1To30: 100, days31To60: 0, days61To90: 0, over90: 0 },
        },
        items: [{
          id: 1,
          code: '000001',
          name: 'Cliente',
          branch: 'MEXICO',
          isActive: true,
          paymentTermDays: 30,
          actualPaymentTermDays: 28,
          creditLimit: 1000,
          totalBalance: 250,
          overdueBalance: 100,
          notDueBalance: 150,
          availableCredit: 750,
          creditUsedPercentage: 25,
          pendingDocumentCount: 2,
          overdueDocumentCount: 1,
          oldestOverdueDate: '2026-08-15',
          maximumDaysOverdue: 19,
          lastPurchaseAt: '2026-09-01',
          lastPaymentAt: '2026-08-31',
          lastOrderAt: '2026-08-30',
          accumulatedSales: 5000,
          openOrderCount: 2,
          openOrderAmount: 300,
          risk: 'watch',
        }],
        total: 1,
      }),
    };

    const result = await new GetClientAnalytics(repository).execute({
      status: 'active',
      risk: 'all',
      page: 1,
      pageSize: 25,
    });

    expect(result.data.scope).toEqual({
      branchCode: '01',
      branchName: 'MÉXICO',
      asOf: '2026-09-03',
    });
    expect(result.data.clients[0]).toMatchObject({ code: '000001', risk: 'watch' });
    expect(result.pagination).toEqual({ page: 1, pageSize: 25, total: 1 });
  });
});
