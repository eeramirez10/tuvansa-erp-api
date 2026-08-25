import { describe, expect, it } from 'vitest';
import { GetClientBalance } from '../src/modules/accounts-receivable/clients/application/use-cases/get-client-balance.js';
import { ClientBalanceDocument } from '../src/modules/accounts-receivable/clients/domain/entities/client-balance-document.js';
import type {
  ClientBalanceRepository,
  ClientBalanceResult,
} from '../src/modules/accounts-receivable/clients/domain/repositories/client-balance-repository.js';

const balanceResult: ClientBalanceResult = {
  client: { id: 10, code: '000010', name: 'Cliente de prueba', currentBalance: 100 },
  summary: {
    totalBalance: 100,
    overdueBalance: 100,
    notDueBalance: 0,
    documentCount: 1,
    overdueDocumentCount: 1,
    notDueDocumentCount: 0,
  },
  items: [ClientBalanceDocument.create({
    id: 1,
    number: 'F0001',
    date: '2026-01-01',
    dueDate: '2026-01-31',
    daysOverdue: 30,
    sign: 'charge',
    amountInBaseCurrency: 100,
    amount: 100,
    currency: { id: 1, name: 'PESOS' },
    exchangeRate: 1,
    reference: 'REF-1',
    scheduledDate: null,
    appliesToClientCode: '000010',
    branchId: null,
    deliveryReceipt: '',
    deliveryReceiptDate: null,
    customerOrder: 'ORDER-1',
    internalReference: '',
    status: '',
    isCanceled: false,
  })],
  total: 1,
};

describe('GetClientBalance', () => {
  it('devuelve documentos, resumen y paginacion', async () => {
    const repository: ClientBalanceRepository = {
      searchByClient: async () => balanceResult,
    };
    const useCase = new GetClientBalance(repository);

    const result = await useCase.execute({
      clientId: 10,
      dueStatus: 'all',
      page: 1,
      pageSize: 25,
    });

    expect(result.data.summary.totalBalance).toBe(100);
    expect(result.data.documents[0]).toMatchObject({ number: 'F0001', daysOverdue: 30 });
    expect(result.pagination).toEqual({ page: 1, pageSize: 25, total: 1 });
  });

  it('reporta cliente inexistente', async () => {
    const repository: ClientBalanceRepository = {
      searchByClient: async () => null,
    };
    const useCase = new GetClientBalance(repository);

    await expect(useCase.execute({
      clientId: 999,
      dueStatus: 'all',
      page: 1,
      pageSize: 25,
    })).rejects.toMatchObject({ code: 'NOT_FOUND', statusCode: 404 });
  });
});
