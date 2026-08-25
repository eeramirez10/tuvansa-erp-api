import { describe, expect, it } from 'vitest';
import { GetClientMovements } from '../src/modules/accounts-receivable/clients/application/use-cases/get-client-movements.js';
import { ClientMovement } from '../src/modules/accounts-receivable/clients/domain/entities/client-movement.js';
import type {
  ClientMovementsRepository,
  ClientMovementsResult,
} from '../src/modules/accounts-receivable/clients/domain/repositories/client-movements-repository.js';

const movementsResult: ClientMovementsResult = {
  client: { id: 10, code: '000010', name: 'Cliente de prueba', currentBalance: 75 },
  summary: {
    openingBalance: 50,
    charges: 100,
    credits: 75,
    netMovement: 25,
    closingBalance: 75,
    movementCount: 1,
  },
  items: [ClientMovement.create({
    id: 1,
    date: '2026-08-24',
    movementType: { code: 'FA', description: 'FACTURA' },
    amount: 100,
    runningBalance: 150,
    paymentReference: 'REF-1',
    exchangeRate: 1,
    policy: '',
    receiptNumber: 0,
    userId: 1,
    document: null,
  })],
};

describe('GetClientMovements', () => {
  it('devuelve movimientos y paginacion', async () => {
    const repository: ClientMovementsRepository = {
      searchByClient: async () => movementsResult,
    };
    const useCase = new GetClientMovements(repository);

    const result = await useCase.execute({ clientId: 10, page: 1, pageSize: 25 });

    expect(result.data.summary.closingBalance).toBe(75);
    expect(result.data.movements[0]).toMatchObject({ charge: 100, credit: 0 });
    expect(result.pagination).toEqual({ page: 1, pageSize: 25, total: 1 });
  });

  it('reporta cliente inexistente', async () => {
    const repository: ClientMovementsRepository = {
      searchByClient: async () => null,
    };
    const useCase = new GetClientMovements(repository);

    await expect(useCase.execute({ clientId: 999, page: 1, pageSize: 25 }))
      .rejects.toMatchObject({ code: 'NOT_FOUND', statusCode: 404 });
  });
});
