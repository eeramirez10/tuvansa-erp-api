import { expect, it, vi } from 'vitest';
import { LegacyMysqlClientMovementsDataSource } from '../src/modules/accounts-receivable/clients/infrastructure/datasources/legacy-mysql-client-movements-data-source.js';
import { legacyMysqlPool } from '../src/shared/infrastructure/database/legacy-mysql-pool.js';

vi.mock('../src/shared/infrastructure/database/legacy-mysql-pool.js', () => ({ legacyMysqlPool: { execute: vi.fn() } }));

it('pages Movimientos on legacy MySQL while keeping the full FAX history in each running balance', async () => {
  const execute = vi.mocked(legacyMysqlPool.execute);
  execute.mockResolvedValueOnce([[{ id: 7, code: 'C007', name: 'Cliente', currentBalance: 75 }], []])
    .mockResolvedValueOnce([[{ movementCount: 2, charges: 25, credits: 50, netMovement: -25 }], []])
    .mockResolvedValueOnce([[{ balance: 100 }], []])
    .mockResolvedValueOnce([[{ id: 27, movementDate: '2025-12-10', amount: -50, runningBalance: 75, documentId: null }], []]);

  const result = await new LegacyMysqlClientMovementsDataSource().searchByClient({
    clientId: 7, dateFrom: '2025-12-10', dateTo: '2025-12-10', limit: 1, offset: 1,
  });
  const [sql, pageParameters] = execute.mock.calls[3]!;
  expect(sql).not.toMatch(/\bWITH\b|\bOVER\s*\(/i);
  expect(sql).toContain('earlier.AFECHA < ledger.movementDate');
  expect(sql).toContain('earlier.AFECHA <=> ledger.movementDate AND earlier.ASEQ <= ledger.id');
  expect(sql).toContain('earlier.CLISEQ = ledger.clientId');
  expect(sql).toMatch(/a\.AFECHA >= \? AND a\.AFECHA <= \?\s+ORDER BY a\.ASEQ\s+LIMIT \? OFFSET \?/);
  expect(pageParameters).toEqual([7, '2025-12-10', '2025-12-10', 1, 1]);
  expect(result?.summary).toMatchObject({ openingBalance: 100, charges: 25, credits: 50, closingBalance: 75, movementCount: 2 });
  expect(result?.items.map((row) => row.toPrimitives())).toMatchObject([{ id: 27, amount: -50, runningBalance: 75 }]);
});
