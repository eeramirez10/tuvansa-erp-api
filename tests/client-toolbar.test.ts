import { describe, expect, it } from 'vitest';
import { CreateClient } from '../src/modules/accounts-receivable/clients/application/use-cases/create-client.js';
import { DeleteClient } from '../src/modules/accounts-receivable/clients/application/use-cases/delete-client.js';
import { NavigateClient } from '../src/modules/accounts-receivable/clients/application/use-cases/navigate-client.js';
import { UpdateClient } from '../src/modules/accounts-receivable/clients/application/use-cases/update-client.js';
import { Client } from '../src/modules/accounts-receivable/clients/domain/entities/client.js';
import type { ClientToolbarRepository } from '../src/modules/accounts-receivable/clients/domain/repositories/client-toolbar-repository.js';
import type { ClientsRepository } from '../src/modules/accounts-receivable/clients/domain/repositories/clients-repository.js';

const client = Client.create({
  id: 10,
  code: '000010',
  name: 'Cliente de prueba',
  isActive: true,
  deactivatedAt: null,
  address: {
    street: '', exteriorNumber: '', interiorNumber: '', neighborhood: '', borough: '',
    city: '', state: '', postalCode: '', countryCode: '',
  },
  contact: { name: '', phones: '', fax: '', email: '', website: '' },
  fiscal: { taxId: '', curp: '', branch: '', accountingAccount: '1105001' },
  indicators: { hasEvents: false },
  terms: {
    priceList: 1,
    discounts: [0, 0, 0],
    paymentTermDays: 0,
    creditLimit: 0,
    creditExpiresAt: null,
    reviewDay: '',
    reviewTime: '',
    paymentDay: '',
    paymentTime: '',
    applyToClientCode: '',
    reviewStartsFromInvoice: false,
  },
  totals: {
    actualPaymentTermDays: 0,
    previousBalance: 0,
    currentBalance: 0,
    availableCredit: 0,
    accumulatedSales: 0,
    lastPurchaseAt: null,
    lastPaymentAt: null,
    lastOrderAt: null,
  },
  createdAt: '2026-08-26',
});

const toolbarRepository = (
  overrides: Partial<ClientToolbarRepository> = {},
): ClientToolbarRepository => ({
  findAdjacent: async () => client,
  codeExists: async () => false,
  accountingAccountExists: async () => true,
  create: async () => client,
  update: async () => client,
  delete: async () => ({ status: 'deleted' }),
  ...overrides,
});

const clientsRepository: ClientsRepository = {
  findById: async () => client,
  search: async () => ({ items: [], total: 0 }),
};

describe('Barra principal del catalogo de clientes', () => {
  it('crea usando la cuenta contable por defecto capturada en OMNIS', async () => {
    let accountUsed = '';
    const repository = toolbarRepository({
      accountingAccountExists: async (account) => {
        accountUsed = account;
        return true;
      },
    });

    const response = await new CreateClient(repository).execute({
      code: '000010',
      name: 'Cliente de prueba',
    });

    expect(accountUsed).toBe('1105001');
    expect(response.id).toBe(10);
  });

  it('rechaza un codigo de cliente duplicado', async () => {
    const useCase = new CreateClient(toolbarRepository({ codeExists: async () => true }));

    await expect(useCase.execute({ code: '000010', name: 'Duplicado' }))
      .rejects.toMatchObject({ code: 'CLIENT_CODE_EXISTS', statusCode: 409 });
  });

  it('modifica solamente los campos recibidos', async () => {
    let changedName: string | undefined;
    const useCase = new UpdateClient(toolbarRepository({
      update: async (_clientId, values) => {
        changedName = values.name;
        return client;
      },
    }));

    await useCase.execute(10, { name: 'Nombre cambiado' });
    expect(changedName).toBe('Nombre cambiado');
  });

  it('impide borrar un cliente con relaciones', async () => {
    const useCase = new DeleteClient(toolbarRepository({
      delete: async () => ({ status: 'in-use', relation: 'fdoc' }),
    }));

    await expect(useCase.execute(10))
      .rejects.toMatchObject({ code: 'CLIENT_IN_USE', statusCode: 409 });
  });

  it('devuelve null al llegar al extremo de la navegacion', async () => {
    const useCase = new NavigateClient(
      toolbarRepository({ findAdjacent: async () => null }),
      clientsRepository,
    );

    await expect(useCase.execute(10, 'next')).resolves.toBeNull();
  });
});
