import { describe, expect, it } from 'vitest';
import { GetClient } from '../src/modules/accounts-receivable/clients/application/use-cases/get-client.js';
import { Client } from '../src/modules/accounts-receivable/clients/domain/entities/client.js';
import type { ClientsRepository } from '../src/modules/accounts-receivable/clients/domain/repositories/clients-repository.js';

const client = Client.create({
  id: 1,
  code: '000001',
  name: 'Cliente de prueba',
  isActive: true,
  deactivatedAt: null,
  address: {
    street: 'Calle 1',
    exteriorNumber: '10',
    interiorNumber: '',
    neighborhood: 'Centro',
    borough: '',
    city: 'Mexico',
    state: 'CDMX',
    postalCode: '01000',
    countryCode: 'MEX',
  },
  contact: {
    name: 'Contacto',
    phones: '5555555555',
    fax: '',
    email: 'contacto@example.com',
    website: 'example.com',
  },
  fiscal: {
    taxId: 'XAXX010101000',
    curp: '',
    branch: '001',
    accountingAccount: '1105001',
  },
  indicators: { hasEvents: true },
  terms: {
    priceList: 1,
    discounts: [0, 0, 0],
    paymentTermDays: 30,
    creditLimit: 1000,
    creditExpiresAt: null,
    reviewDay: 'LUNES',
    reviewTime: '10:00',
    paymentDay: 'VIERNES',
    paymentTime: '12:00',
    applyToClientCode: '',
    reviewStartsFromInvoice: true,
  },
  totals: {
    actualPaymentTermDays: 20,
    previousBalance: 0,
    currentBalance: 100,
    availableCredit: 900,
    accumulatedSales: 500,
    lastPurchaseAt: null,
    lastPaymentAt: null,
    lastOrderAt: null,
  },
  createdAt: '2026-01-01',
});

const repository: ClientsRepository = {
  findById: async () => client,
  search: async () => ({ items: [], total: 0 }),
};

describe('GetClient', () => {
  it('conserva los indicadores y condiciones visibles de OMNIS', async () => {
    const response = await new GetClient(repository).execute(1);

    expect(response.indicators.hasEvents).toBe(true);
    expect(response.terms.reviewStartsFromInvoice).toBe(true);
    expect(response.totals.availableCredit).toBe(900);
  });
});
