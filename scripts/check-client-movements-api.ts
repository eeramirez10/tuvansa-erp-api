import type { RowDataPacket } from 'mysql2';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { legacyMysqlPool } from '../src/shared/infrastructure/database/legacy-mysql-pool.js';

interface ClientCandidateRow extends RowDataPacket {
  clientId: number;
}

interface MovementsResponseBody {
  data: {
    client: { id: number; code: string };
    summary: { movementCount: number; closingBalance: number };
    movements: Array<{ id: number; charge: number; credit: number; runningBalance: number }>;
  };
  pagination: { total: number };
}

const app = createApp();

try {
  const [candidates] = await legacyMysqlPool.execute<ClientCandidateRow[]>(`
    SELECT a.CLISEQ AS clientId
    FROM fax a
    JOIN fdoc d ON d.DSEQ = a.DSEQ
    JOIN fcli c ON c.CLISEQ = a.CLISEQ
    WHERE a.CLISEQ <> 0
      AND a.AMES = 1
      AND IF(d.DEST IS NULL, 0, d.DEST) = 0
      AND d.DMULTICIA = 1
    GROUP BY a.CLISEQ, c.CLICOD
    ORDER BY c.CLICOD = '000001' DESC, COUNT(*) DESC
    LIMIT 1
  `);
  const candidate = candidates[0];

  if (candidate === undefined) {
    throw new Error('No se encontro un cliente con movimientos');
  }

  const response = await request(app).get(
    `/api/accounts-receivable/clients/${candidate.clientId}/movements?page=1&pageSize=5`,
  );
  const body = response.body as MovementsResponseBody;

  if (response.status !== 200 || body.data.movements.length === 0) {
    throw new Error(`La consulta de movimientos fallo con HTTP ${response.status}`);
  }

  const periodResponse = await request(app).get(
    `/api/accounts-receivable/clients/${candidate.clientId}/movements?dateFrom=2026-08-24&dateTo=2026-08-24&page=1&pageSize=5`,
  );
  const invalidPeriodResponse = await request(app).get(
    `/api/accounts-receivable/clients/${candidate.clientId}/movements?dateFrom=2026-08-25&dateTo=2026-08-24`,
  );
  const missingClientResponse = await request(app).get(
    '/api/accounts-receivable/clients/2147483647/movements',
  );

  if (
    periodResponse.status !== 200
    || invalidPeriodResponse.status !== 400
    || missingClientResponse.status !== 404
  ) {
    throw new Error('Fallaron las validaciones adicionales de movimientos');
  }

  console.log({
    status: response.status,
    client: body.data.client,
    returnedItems: body.data.movements.length,
    total: body.pagination.total,
    summary: body.data.summary,
    firstMovement: body.data.movements[0],
    validations: {
      period: periodResponse.status,
      invalidPeriod: invalidPeriodResponse.status,
      missingClient: missingClientResponse.status,
    },
  });
} finally {
  await legacyMysqlPool.end();
}
