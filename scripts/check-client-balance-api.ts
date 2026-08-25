import type { RowDataPacket } from 'mysql2';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { legacyMysqlPool } from '../src/shared/infrastructure/database/legacy-mysql-pool.js';

interface ClientCandidateRow extends RowDataPacket {
  clientId: number;
}

interface BalanceResponseBody {
  data: {
    client: { id: number; code: string; currentBalance: number };
    summary: {
      totalBalance: number;
      overdueBalance: number;
      notDueBalance: number;
      documentCount: number;
    };
    documents: Array<{ number: string; amountInBaseCurrency: number; daysOverdue: number }>;
  };
  pagination: { total: number };
}

const app = createApp();

try {
  const [candidates] = await legacyMysqlPool.execute<ClientCandidateRow[]>(`
    SELECT c.CLISEQ AS clientId
    FROM fcli c
    JOIN fdoc d ON d.CLISEQ = c.CLISEQ
      AND d.DEST = 0
      AND d.DMULTICIA = 1
      AND d.DESCXC = 1
    GROUP BY c.CLISEQ, c.CLISACT
    HAVING ABS(SUM(d.DCANT) - c.CLISACT) < 0.1
    ORDER BY c.CLICOD = '000001' DESC, COUNT(*) DESC
    LIMIT 1
  `);
  const candidate = candidates[0];

  const [zeroBalanceCandidates] = await legacyMysqlPool.execute<ClientCandidateRow[]>(`
    SELECT c.CLISEQ AS clientId
    FROM fcli c
    WHERE c.CLISEQ > 0
      AND NOT EXISTS (
        SELECT 1
        FROM fdoc d
        WHERE d.CLISEQ = c.CLISEQ
          AND d.DEST = 0
          AND d.DMULTICIA = 1
          AND d.DESCXC = 1
      )
    ORDER BY c.CLISEQ
    LIMIT 1
  `);
  const zeroBalanceCandidate = zeroBalanceCandidates[0];

  if (candidate === undefined || zeroBalanceCandidate === undefined) {
    throw new Error('No se encontraron clientes para validar saldo');
  }

  const response = await request(app).get(
    `/api/accounts-receivable/clients/${candidate.clientId}/balance?page=1&pageSize=5`,
  );
  const body = response.body as BalanceResponseBody;
  const firstDocument = body.data.documents[0];

  if (response.status !== 200 || firstDocument === undefined) {
    throw new Error(`La consulta de saldo fallo con HTTP ${response.status}`);
  }

  const difference = Math.abs(body.data.summary.totalBalance - body.data.client.currentBalance);
  if (difference >= 0.1 || body.pagination.total !== body.data.summary.documentCount) {
    throw new Error('El resumen de saldo no coincide con los documentos abiertos');
  }

  const searchResponse = await request(app).get(
    `/api/accounts-receivable/clients/${candidate.clientId}/balance?q=${encodeURIComponent(firstDocument.number)}`,
  );
  const overdueResponse = await request(app).get(
    `/api/accounts-receivable/clients/${candidate.clientId}/balance?dueStatus=overdue`,
  );
  const notDueResponse = await request(app).get(
    `/api/accounts-receivable/clients/${candidate.clientId}/balance?dueStatus=notDue`,
  );
  const invalidStatusResponse = await request(app).get(
    `/api/accounts-receivable/clients/${candidate.clientId}/balance?dueStatus=invalid`,
  );
  const missingClientResponse = await request(app).get(
    '/api/accounts-receivable/clients/2147483647/balance',
  );
  const zeroBalanceResponse = await request(app).get(
    `/api/accounts-receivable/clients/${zeroBalanceCandidate.clientId}/balance`,
  );
  const zeroBalanceBody = zeroBalanceResponse.body as BalanceResponseBody;

  if (
    searchResponse.status !== 200
    || overdueResponse.status !== 200
    || notDueResponse.status !== 200
    || invalidStatusResponse.status !== 400
    || missingClientResponse.status !== 404
    || zeroBalanceResponse.status !== 200
    || zeroBalanceBody.data.summary.documentCount !== 0
    || zeroBalanceBody.data.summary.overdueBalance !== 0
    || zeroBalanceBody.data.summary.notDueBalance !== 0
  ) {
    throw new Error('Fallaron las validaciones adicionales de saldo');
  }

  console.log({
    status: response.status,
    client: body.data.client,
    returnedItems: body.data.documents.length,
    total: body.pagination.total,
    summary: body.data.summary,
    firstDocument,
    validations: {
      search: searchResponse.status,
      overdue: overdueResponse.status,
      notDue: notDueResponse.status,
      invalidStatus: invalidStatusResponse.status,
      missingClient: missingClientResponse.status,
      zeroBalance: zeroBalanceResponse.status,
    },
  });
} finally {
  await legacyMysqlPool.end();
}
