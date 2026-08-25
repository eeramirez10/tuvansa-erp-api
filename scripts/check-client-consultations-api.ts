import request from 'supertest';
import { createApp } from '../src/app.js';
import { legacyMysqlPool } from '../src/shared/infrastructure/database/legacy-mysql-pool.js';

interface ConsultationResponseBody {
  data?: {
    client?: { id: number; code: string };
    items?: unknown[];
  };
  pagination?: {
    page: number;
    pageSize: number;
    total: number;
  };
}

const clientId = 15331;
const endpoints = [
  'invoices',
  'orders',
  'products/ordered',
  'products/quoted',
  'products/sold',
  'products/sold-detail',
  'sales/annual',
  'sales/annual-summary',
  'sales/by-branch',
  'sales/edi',
  'work-in-progress',
  'ct/products/ordered',
  'ct/products/sold',
  'ct/work-in-progress',
] as const;

const app = createApp();

try {
  const results = await Promise.all(endpoints.map(async (endpoint) => {
    const response = await request(app).get(
      `/api/accounts-receivable/clients/${clientId}/${endpoint}?page=1&pageSize=2`,
    );
    const body = response.body as ConsultationResponseBody;

    if (
      response.status !== 200
      || body.data?.client?.id !== clientId
      || !Array.isArray(body.data.items)
      || body.pagination?.page !== 1
      || body.pagination.pageSize !== 2
      || body.pagination.total < body.data.items.length
    ) {
      throw new Error(`${endpoint} devolvio una respuesta invalida: ${response.status}`);
    }

    return {
      endpoint,
      status: response.status,
      total: body.pagination.total,
      returned: body.data.items.length,
      firstItem: body.data.items[0] ?? null,
    };
  }));

  const invalidPagination = await request(app).get(
    `/api/accounts-receivable/clients/${clientId}/invoices?page=0`,
  );
  const missingClient = await request(app).get(
    '/api/accounts-receivable/clients/2147483647/invoices',
  );

  if (invalidPagination.status !== 400 || missingClient.status !== 404) {
    throw new Error('Fallaron las validaciones HTTP adicionales');
  }

  console.dir({
    clientId,
    results,
    validations: {
      invalidPagination: invalidPagination.status,
      missingClient: missingClient.status,
    },
  }, { depth: null });
} finally {
  await legacyMysqlPool.end();
}
