import request from 'supertest';
import { createApp } from '../src/app.js';
import { legacyMysqlPool } from '../src/shared/infrastructure/database/legacy-mysql-pool.js';

const app = createApp();
const code = `Q${Date.now().toString().slice(-5)}`;
let clientId: number | undefined;

const requireStatus = (
  actual: number,
  expected: number,
  operation: string,
  details?: unknown,
): void => {
  if (actual !== expected) {
    throw new Error(
      `${operation}: se esperaba HTTP ${expected} y se recibio ${actual}. ${JSON.stringify(details)}`,
    );
  }
};

try {
  const knownClientId = 15331;
  requireStatus(
    (await request(app).get(`/api/accounts-receivable/clients/${knownClientId}/previous`)).status,
    200,
    'Anterior',
  );
  requireStatus(
    (await request(app).get(`/api/accounts-receivable/clients/${knownClientId}/next`)).status,
    200,
    'Siguiente',
  );

  const created = await request(app)
    .post('/api/accounts-receivable/clients')
    .send({ code, name: 'Cliente temporal API' });
  requireStatus(created.status, 201, 'Alta', created.body);
  clientId = created.body.data.id as number;

  const searched = await request(app)
    .get('/api/accounts-receivable/clients')
    .query({ q: code, page: 1, pageSize: 10 });
  requireStatus(searched.status, 200, 'Busqueda');
  if (!searched.body.data.some((client: { id: number }) => client.id === clientId)) {
    throw new Error('Busqueda: el cliente creado no aparecio en el resultado');
  }

  const updated = await request(app)
    .patch(`/api/accounts-receivable/clients/${clientId}`)
    .send({ name: 'Cliente temporal API editado' });
  requireStatus(updated.status, 200, 'Cambio');
  if (updated.body.data.name !== 'Cliente temporal API editado') {
    throw new Error('Cambio: no se devolvio la razon social modificada');
  }

  const deleted = await request(app).delete(`/api/accounts-receivable/clients/${clientId}`);
  requireStatus(deleted.status, 204, 'Baja');
  clientId = undefined;

  console.log('Barra de clientes verificada: buscar, anterior, siguiente, alta, cambio y baja.');
} finally {
  if (clientId !== undefined) {
    await legacyMysqlPool.execute('DELETE FROM fcli WHERE CLISEQ = ? AND CLICOD = ?', [clientId, code]);
  }
  await legacyMysqlPool.end();
}
