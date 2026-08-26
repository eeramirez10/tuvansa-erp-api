import request from 'supertest';
import { createApp } from '../src/app.js';
import { legacyMysqlPool } from '../src/shared/infrastructure/database/legacy-mysql-pool.js';

const app = createApp();
const productId = 47087;

const requireStatus = (actual: number, expected: number, operation: string): void => {
  if (actual !== expected) {
    throw new Error(`${operation}: se esperaba HTTP ${expected} y se recibio ${actual}`);
  }
};

try {
  const detail = await request(app).get(`/api/inventories/products/${productId}`);
  requireStatus(detail.status, 200, 'Detalle');
  if (detail.body.data.code !== '004212899') {
    throw new Error('Detalle: el codigo no corresponde al producto capturado');
  }

  const search = await request(app)
    .get('/api/inventories/products')
    .query({ q: '004212899', page: 1, pageSize: 10 });
  requireStatus(search.status, 200, 'Busqueda');
  if (!search.body.data.some((product: { id: number }) => product.id === productId)) {
    throw new Error('Busqueda: no se encontro el producto capturado');
  }

  requireStatus(
    (await request(app).get(`/api/inventories/products/${productId}/previous`)).status,
    200,
    'Anterior',
  );
  requireStatus(
    (await request(app).get(`/api/inventories/products/${productId}/next`)).status,
    200,
    'Siguiente',
  );

  console.log('Catalogo de productos verificado: ficha, busqueda, anterior y siguiente.');
} finally {
  await legacyMysqlPool.end();
}
