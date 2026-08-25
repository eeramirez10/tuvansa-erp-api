import request from 'supertest';
import { createApp } from '../src/app.js';
import { legacyMysqlPool } from '../src/shared/infrastructure/database/legacy-mysql-pool.js';

interface ActionResponseBody {
  data?: Record<string, unknown> & {
    client?: { id: number; code: string };
  };
  pagination?: {
    page: number;
    pageSize: number;
    total: number;
  };
}

const clientId = 15331;
const actions = [
  { endpoint: 'classifications', key: 'classifications', paginated: false },
  { endpoint: 'destinations', key: 'destinations', paginated: false },
  { endpoint: 'block-status', key: 'blockStatus', paginated: false },
  { endpoint: 'discounts', key: 'discounts', paginated: true },
  { endpoint: 'events', key: 'events', paginated: true },
  { endpoint: 'branches', key: 'branches', paginated: true },
  { endpoint: 'photo', key: 'photo', paginated: false },
  { endpoint: 'contacts', key: 'contacts', paginated: true },
] as const;

const app = createApp();

try {
  const results = await Promise.all(actions.map(async (action) => {
    const query = action.paginated ? '?page=1&pageSize=2' : '';
    const response = await request(app).get(
      `/api/accounts-receivable/clients/${clientId}/actions/${action.endpoint}${query}`,
    );
    const body = response.body as ActionResponseBody;
    const payload = body.data?.[action.key];

    if (
      response.status !== 200
      || body.data?.client?.id !== clientId
      || payload === undefined
      || (action.paginated && body.pagination?.pageSize !== 2)
    ) {
      throw new Error(
        `${action.endpoint} devolvio una respuesta invalida: ${response.status} ${JSON.stringify(body)}`,
      );
    }

    return {
      action: action.endpoint,
      status: response.status,
      total: body.pagination?.total ?? null,
      returned: Array.isArray(payload) ? payload.length : null,
      payload,
    };
  }));

  const invalidPagination = await request(app).get(
    `/api/accounts-receivable/clients/${clientId}/actions/events?page=0`,
  );
  const missingClient = await request(app).get(
    '/api/accounts-receivable/clients/2147483647/actions/contacts',
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
  }, { depth: 4 });
} finally {
  await legacyMysqlPool.end();
}
