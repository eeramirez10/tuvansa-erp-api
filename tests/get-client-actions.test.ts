import { describe, expect, it } from 'vitest';
import { GetClientActions } from '../src/modules/accounts-receivable/clients/application/use-cases/get-client-actions.js';
import type { ClientActionsRepository } from '../src/modules/accounts-receivable/clients/domain/repositories/client-actions-repository.js';

const noResult = async () => null;

const createRepository = (
  overrides: Partial<ClientActionsRepository>,
): ClientActionsRepository => ({
  findClassifications: noResult,
  findDestinations: noResult,
  findBlockStatus: noResult,
  findDiscounts: noResult,
  findEvents: noResult,
  findBranches: noResult,
  findPhoto: noResult,
  findContacts: noResult,
  ...overrides,
});

describe('GetClientActions', () => {
  it('devuelve clasificaciones con el cliente', async () => {
    const useCase = new GetClientActions(createRepository({
      findClassifications: async () => ({
        client: { id: 1, code: '000001', name: 'Cliente', currentBalance: 0 },
        payload: {
          classifications: [{
            id: 10,
            position: 1,
            key: 'agent',
            label: 'AGENTE',
            code: '1202',
            description: 'AGENTE DE PRUEBA',
            number: '202',
            type: '1',
            categoryType: 0,
          }],
          selectedPosition: 2,
          options: [],
        },
      }),
    }));

    const response = await useCase.classifications({ clientId: 1, position: 2 });

    expect(response.data.client.code).toBe('000001');
    expect(response.data.classifications[0]).toMatchObject({ label: 'AGENTE', code: '1202' });
    expect(response.data.selectedPosition).toBe(2);
  });

  it('devuelve paginacion para contactos', async () => {
    const useCase = new GetClientActions(createRepository({
      findContacts: async () => ({
        client: { id: 1, code: '000001', name: 'Cliente', currentBalance: 0 },
        payload: { contacts: [] },
        total: 0,
      }),
    }));

    const response = await useCase.contacts({ clientId: 1, page: 2, pageSize: 10 });

    expect(response.pagination).toEqual({ page: 2, pageSize: 10, total: 0 });
  });

  it('reporta cliente inexistente', async () => {
    const useCase = new GetClientActions(createRepository({}));

    await expect(useCase.blockStatus(999))
      .rejects.toMatchObject({ code: 'NOT_FOUND', statusCode: 404 });
  });
});
