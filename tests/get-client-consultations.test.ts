import { describe, expect, it } from 'vitest';
import { GetClientConsultations } from '../src/modules/accounts-receivable/clients/application/use-cases/get-client-consultations.js';
import type { ClientInvoice } from '../src/modules/accounts-receivable/clients/domain/entities/client-consultation.js';
import type {
  ClientConsultationResult,
  ClientConsultationsRepository,
} from '../src/modules/accounts-receivable/clients/domain/repositories/client-consultations-repository.js';

const noResult = async () => null;

const createRepository = (
  overrides: Partial<ClientConsultationsRepository>,
): ClientConsultationsRepository => ({
  findInvoices: noResult,
  findOrders: noResult,
  findOrderedProducts: noResult,
  findQuotedProducts: noResult,
  findSoldProducts: noResult,
  findSoldProductDetails: noResult,
  findAnnualSales: noResult,
  findAnnualSalesSummary: noResult,
  findSalesByBranch: noResult,
  findEdiSales: noResult,
  findWorkInProgress: noResult,
  findCtOrderedProducts: noResult,
  findCtSoldProducts: noResult,
  ...overrides,
});

const invoice: ClientInvoice = {
  id: 10,
  number: 'FA00010',
  date: '2026-08-01',
  dueDate: '2026-08-31',
  amount: 100,
  reference: 'REF-10',
  paymentDate: null,
  affectsAccountsReceivable: true,
  deliveryReceipt: '',
  deliveryReceiptDate: null,
  route: 0,
  exchangeRate: 1,
  currencyId: 1,
  branch: 0,
  customerOrder: 'ORDER-10',
  department: '',
  routeDate: null,
  parameter1: '',
  scheduledDate: null,
};

describe('GetClientConsultations', () => {
  it('devuelve la consulta solicitada con paginacion', async () => {
    const result: ClientConsultationResult<ClientInvoice> = {
      client: { id: 1, code: '000001', name: 'Cliente', currentBalance: 100 },
      items: [invoice],
      total: 1,
    };
    const useCase = new GetClientConsultations(createRepository({
      findInvoices: async () => result,
    }));

    const response = await useCase.invoices({ clientId: 1, page: 1, pageSize: 25 });

    expect(response.data.items[0]).toMatchObject({ number: 'FA00010', amount: 100 });
    expect(response.pagination).toEqual({ page: 1, pageSize: 25, total: 1 });
  });

  it('reporta cliente inexistente', async () => {
    const useCase = new GetClientConsultations(createRepository({}));

    await expect(useCase.orders({ clientId: 999, page: 1, pageSize: 25 }))
      .rejects.toMatchObject({ code: 'NOT_FOUND', statusCode: 404 });
  });
});
