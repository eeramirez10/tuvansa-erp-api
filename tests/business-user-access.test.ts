import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { effectiveUserSettings, type WebIdentity } from '../src/modules/general-data/users/domain/user-directory.js';
import { createBusinessAccess } from '../src/modules/general-data/users/presentation/business-access.js';
import { cookieName } from '../src/modules/general-data/users/presentation/web-session-http.js';
import { customerAllowed } from '../src/shared/infrastructure/http/customer-scope.js';
import { errorHandler } from '../src/shared/infrastructure/http/error-handler.js';

const identity: WebIdentity = {
  id: 'g-1', identification: 'operador', name: 'Persona de prueba', legacyId: 1, group: 18,
  administrator: false, access: effectiveUserSettings(),
};
const normal = 'a'.repeat(43);
const limited = 'b'.repeat(43);
const customers = 'c'.repeat(43);
const clientPath = '/api/accounts-receivable/clients';
const app = express().use(express.json()).use('/api', createBusinessAccess(async token => {
  if (token === normal) return identity;
  if (token === limited) return { ...identity, access: { ...identity.access, hideCosts: true, hideBalances: true, captureFrom: '2026-11-01', captureUntil: '2026-11-30' } };
  if (token === customers) return { ...identity, access: { ...identity.access, ownCustomersOnly: true, classifier: 1, parameter: '201' } };
  return null;
}, async access => access.classifier === 1 && access.parameter === '201' ? new Set([11]) : new Set()));

app.get('/api/inventories/products/:id', (_request, response) => {
  response.json({ data: { prices: { costs: { average: 725 }, sale: [{ amount: 900 }] } } });
});
app.get('/api/inventories/reports/inventory-by-family', (_request, response) => response.json({ subtotal: 725 }));
app.get(clientPath, async (_request, response) => {
  await new Promise<void>(resolve => setTimeout(resolve, 10));
  response.json({ data: [11, 22].filter(customerAllowed) });
});
app.get(`${clientPath}/:id`, (incoming, response) => {
  response.json({ data: { id: Number(incoming.params.id), totals: { previousBalance: 325, currentBalance: 925, availableCredit: 75 } } });
});
app.get(`${clientPath}/:id/balance`, (_request, response) => response.json({ importe: 925 }));
app.post('/api/sales/orders/capture', (_request, response) => response.status(201).json({}));
app.get('/api/sales/reports/sales-by-family', (_request, response) => response.json({ otherCustomers: true }));
app.use(errorHandler);

const cookie = (token: string) => `${cookieName}=${token}`;

describe('Restricciones de la sesión en módulos de negocio', () => {
  it('exige sesión y protege tanto los campos como los reportes sensibles', async () => {
    await request(app).get('/api/inventories/products/17').expect(401);
    const product = await request(app).get('/api/inventories/products/17').set('Cookie', cookie(limited)).expect(200);
    expect(product.body.data.prices).toEqual({ costs: { average: null }, sale: [{ amount: 900 }] });
    const client = await request(app).get(`${clientPath}/11`).set('Cookie', cookie(limited)).expect(200);
    expect(client.body.data.totals).toEqual({ previousBalance: null, currentBalance: null, availableCredit: null });
    await request(app).get(`${clientPath}/11/balance`).set('Cookie', cookie(limited)).expect(403);
    await request(app).get('/api/inventories/reports/inventory-by-family').set('Cookie', cookie(limited)).expect(403);
    expect((await request(app).get('/api/inventories/products/17').set('Cookie', cookie(normal))).body.data.prices.costs.average).toBe(725);
  });

  it('separa clientes permitidos entre peticiones concurrentes y protege el acceso directo', async () => {
    const [restricted, all] = await Promise.all([
      request(app).get(clientPath).set('Cookie', cookie(customers)).expect(200),
      request(app).get(clientPath).set('Cookie', cookie(normal)).expect(200),
    ]);
    expect(restricted.body.data).toEqual([11]);
    expect(all.body.data).toEqual([11, 22]);
    await request(app).get(`${clientPath}/22`).set('Cookie', cookie(customers)).expect(404);
    await request(app).get(`${clientPath}/0x16`).set('Cookie', cookie(customers)).expect(403);
    await request(app).get('/api/sales/reports/sales-by-family').set('Cookie', cookie(customers)).expect(403);
  });

  it('comprueba el periodo de captura y el origen antes de aceptar escrituras', async () => {
    const capture = (origin = 'http://localhost:5173') => request(app).post('/api/sales/orders/capture')
      .set('Host', 'localhost:5173').set('Origin', origin).set('Cookie', cookie(limited));
    await capture().send({ orderedAt: '2026-10-31' }).expect(403);
    await capture().send({ orderedAt: '2026-11-01' }).expect(201);
    await capture('https://otro.example').send({ orderedAt: '2026-11-01' }).expect(403);
  });
});
