import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import express from 'express';
import request from 'supertest';
import { expect, it, vi } from 'vitest';
import { env } from '../src/config/env.js';
import { createAccountingPoliciesModule } from '../src/modules/accounting/policies/accounting-policies-module.js';
import { AccountingPolicy } from '../src/modules/accounting/policies/domain/entities/accounting-policy.js';
import { LegacyMysqlAccountingPoliciesDataSource } from '../src/modules/accounting/policies/infrastructure/datasources/legacy-mysql-accounting-policies-data-source.js';
import type { PostgresClient } from '../src/shared/infrastructure/database/postgres-pool.js';
import { errorHandler } from '../src/shared/infrastructure/http/error-handler.js';
import { postgresWriteBoundary } from '../src/shared/infrastructure/http/postgres-write-boundary.js';

const pool = vi.hoisted(() => ({ connect: vi.fn(), configured: vi.fn() }));
vi.mock('../src/shared/infrastructure/database/postgres-pool.js', async (original) => ({
  ...await original<Record<string, unknown>>(),
  connectPostgres: pool.connect,
  postgresConfigured: pool.configured,
}));

it('verifies the catalog, projects POPAR1, rejects stale saves, recovers retries and rolls back a failed commit', async () => {
  const db = new PGlite();
  const first = { id: 42, number: '312502-0042' };
  const second = { id: 43, number: '312502-0043' };
  const identities = [first, second];
  let failCommit = false;
  let catalog = [
    { code: 'A', description: 'Primero', compositeCode: '4A' },
    { code: 'B', description: 'Segundo', compositeCode: '4B' },
  ];
  // PGlite has one SQL session. Queue independent HTTP handlers at connection checkout.
  let next = Promise.resolve();
  pool.configured.mockReturnValue(true);
  pool.connect.mockImplementation(async (): Promise<PostgresClient> => {
    const previous = next;
    let release!: () => void;
    next = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    return {
      async query<T extends object>(sql: string, values?: unknown[]) {
        if (sql === 'COMMIT' && failCommit) {
          failCommit = false;
          throw new Error('Fallo de prueba antes del commit');
        }
        if (values) return db.query<T>(sql, values);
        const result = await db.exec(sql);
        return { rows: (result.at(-1)?.rows ?? []) as T[] };
      },
      release,
    };
  });
  const byId = vi.spyOn(LegacyMysqlAccountingPoliciesDataSource.prototype, 'findById').mockImplementation(async (id) => {
    const identity = identities.find((item) => item.id === id);
    return identity ? AccountingPolicy.create({
      ...identity, date: '2025-02-04', cheque: '', company: 1, origin: '', applied: id === 42,
      beneficiary: '', family: '', concept: '', amountInWords: '', userId: 0, report: '', auditAt: null,
      postDate: null, classifications: ['4A', 'KEEP'], exchangeRate: 1, usedAt: null,
      totals: { debit: 0, credit: 0, difference: 0 }, movements: [],
    }) : null;
  });
  const byNumber = vi.spyOn(LegacyMysqlAccountingPoliciesDataSource.prototype, 'findByNumber')
    .mockImplementation(async (number) => {
      const identity = identities.find((item) => item.number === number);
      return identity ? byId(identity.id) : null;
    });
  const search = vi.spyOn(LegacyMysqlAccountingPoliciesDataSource.prototype, 'search').mockImplementation(async () => ({
    items: [(await byId(first.id))!, (await byId(second.id))!], total: 2,
  }));
  const classifications = vi.spyOn(LegacyMysqlAccountingPoliciesDataSource.prototype, 'getClassificationCatalog')
    .mockImplementation(async (policy) => {
      const { id, number, classifications: current } = policy.toPrimitives();
      return {
        policy: { id, number }, key: 'classifications', section: 'actions', button: 'Clasificar', source: 'mysql',
        items: catalog, summary: { current, revision: 0, canWrite: false, reason: null },
      };
    });
  const pending = { compositeCode: '4B', revision: 0, requestKey: randomUUID() };
  const previousUrl = env.NEON_DATABASE_URL;
  env.NEON_DATABASE_URL = 'postgres://unused/fixture';
  try {
    const app = express();
    const base = '/api/accounting/policies';
    app.use(express.json());
    app.use('/api', postgresWriteBoundary);
    app.use(base, createAccountingPoliciesModule());
    app.use(errorHandler);
    const panel = (id: number) => `${base}/${id}/actions/classifications`;
    const submit = (id: number, data = pending) => request(app).patch(panel(id)).send(data);

    expect((await request(app).get(panel(first.id)).expect(200)).body.data.summary)
      .toMatchObject({ current: ['4A', 'KEEP'], revision: 0, canWrite: true });
    await submit(first.id, { ...pending, compositeCode: '5B' }).expect(422);
    await submit(99).expect(404);

    const competing = { compositeCode: '4A', revision: 0, requestKey: randomUUID() };
    const writes = await Promise.all([submit(first.id), submit(first.id, competing)]);
    expect(writes.map(({ status }) => status).sort()).toEqual([200, 409]);
    const winner = writes[0]!.status === 200 ? pending : competing;
    const result = writes.find(({ status }) => status === 200)!.body;
    expect(writes.find(({ status }) => status === 409)!.body.error.code).toBe('POLICY_CLASSIFICATION_STALE');
    expect((await submit(first.id, winner).expect(200)).body).toEqual(result);
    await submit(first.id, { ...winner, revision: 1 }).expect(409);
    const expected = [winner.compositeCode, 'KEEP'];
    expect((await request(app).get(`${base}/${first.id}`).expect(200)).body.data.classifications).toEqual(expected);
    expect((await request(app).get(`${base}/by-number/${first.number}`).expect(200)).body.data.classifications).toEqual(expected);
    expect((await request(app).get(base).expect(200)).body.data[0].classifications).toEqual(expected);
    expect((await request(app).get(panel(first.id)).expect(200)).body.data.summary)
      .toMatchObject({ current: expected, revision: 1 });

    failCommit = true;
    await submit(second.id).expect(503);
    expect((await request(app).get(panel(second.id)).expect(200)).body.data.summary)
      .toMatchObject({ current: ['4A', 'KEEP'], revision: 0, canWrite: true });
    await submit(second.id).expect(200);
    expect((await request(app).get(panel(second.id)).expect(200)).body.data.summary)
      .toMatchObject({ current: ['4B', 'KEEP'], revision: 1 });

    catalog = [];
    expect((await request(app).get(panel(first.id)).expect(200)).body.data.summary.canWrite).toBe(false);
    await submit(first.id, { ...pending, revision: 1, requestKey: randomUUID() }).expect(409);
    expect((await db.query('SELECT count(*)::int AS count FROM tuvansa.accounting_policy_classifications')).rows)
      .toEqual([{ count: 2 }]);
  } finally {
    env.NEON_DATABASE_URL = previousUrl;
    byId.mockRestore();
    byNumber.mockRestore();
    search.mockRestore();
    classifications.mockRestore();
    await db.close();
  }
});
