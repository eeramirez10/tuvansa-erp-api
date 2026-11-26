import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import express from 'express';
import request from 'supertest';
import { expect, it } from 'vitest';
import { env } from '../src/config/env.js';
import { DuplicatePolicyLiability } from '../src/modules/accounting/policies/application/use-cases/duplicate-policy-liability.js';
import { ManageManualPolicy } from '../src/modules/accounting/policies/application/use-cases/manage-manual-policy.js';
import type { ManualPolicyReferences } from '../src/modules/accounting/policies/domain/datasources/manual-policy-data-source.js';
import { AccountingPolicy, type AccountingPolicyProps } from '../src/modules/accounting/policies/domain/entities/accounting-policy.js';
import { PostgresManualPolicies } from '../src/modules/accounting/policies/infrastructure/datasources/postgres-manual-policies.js';
import { createManualPolicyRouter } from '../src/modules/accounting/policies/presentation/http/manual-policy-routes.js';
import { createPolicyLiabilityRouter } from '../src/modules/accounting/policies/presentation/http/policy-liability-routes.js';
import { cookieName, requireSessionOrigin, sessionToken } from '../src/modules/general-data/users/presentation/web-session-http.js';
import { localPurchasePayablesSql } from '../src/modules/purchasing/purchase-receptions/infrastructure/datasources/postgres-purchase-payables.js';
import { ApplicationError } from '../src/shared/domain/errors/application-error.js';
import type { PostgresConnectionFactory } from '../src/shared/infrastructure/database/postgres-pool.js';
import { errorHandler } from '../src/shared/infrastructure/http/error-handler.js';
import { postgresWriteBoundary } from '../src/shared/infrastructure/http/postgres-write-boundary.js';

it('matches the rounding captured in German and posts and cancels an atomic supplier charge', async () => {
  const db = new PGlite();
  let available = Promise.resolve();
  let failAudit = false;
  const connect: PostgresConnectionFactory = async () => {
    const ready = available;
    let release!: () => void;
    available = new Promise<void>(resolve => { release = resolve; });
    await ready;
    return {
      async query<T extends object>(sql: string, values?: unknown[]) {
        if (failAudit && sql.includes('INSERT INTO tuvansa.manual_accounting_policy_changes')) throw new Error('Test audit failure');
        if (values) return db.query<T>(sql, values);
        return { rows: ((await db.exec(sql)).at(-1)?.rows ?? []) as T[] };
      },
      release,
    };
  };
  const accounts = [
    { id: 10, code: '6003402005', name: 'Arrendamiento de equipo', type: 2, nature: 0 },
    { id: 11, code: '1118001', name: 'IVA acreditable pagado', type: 2, nature: 0 },
    { id: 12, code: '2001001', name: 'Proveedores nacionales', type: 2, nature: 1 },
  ];
  const refs: ManualPolicyReferences = {
    settings: async () => ({ fiscalStart: '2025-01-01', fiscalEnd: '2025-12-31', periodYear: 2025, levels: [7, 10],
      costCenters: [{ code: 0, name: 'Sin centro' }] }),
    accounts: async () => new Map(accounts.map(account => [account.code, { account, parents: [] }])),
    search: async () => accounts,
  };
  const policy: AccountingPolicyProps = {
    id: 487441, number: '312502-0713', date: '2025-02-20', company: 1, cheque: '', origin: '', applied: true,
    beneficiary: 'Proveedor de prueba', family: 'PASIVO', concept: 'Pasivo de prueba', amountInWords: '', userId: 0,
    report: '', auditAt: null, postDate: null, classifications: [], exchangeRate: 0, usedAt: null,
    totals: { debit: 116.08, credit: 116.08, difference: 0 },
    movements: accounts.map((account, index) => ({ id: 901 + index, accountId: account.id, accountCode: account.code,
      accountName: account.name, accountType: account.type, debit: [100.07, 16.01, 0][index]!, credit: index === 2 ? 116.08 : 0,
      costCenter: 0, reference: '', exchangeRate: 1, reconciled: false })),
  };
  const source = { findById: async (id: number) => id === policy.id ? AccountingPolicy.create(policy) : null };
  let exchangeRate = 20.4722;
  const storage = new PostgresManualPolicies(connect, () => true);
  const manual = new ManageManualPolicy(refs, storage);
  const duplicate = new DuplicatePolicyLiability(source, async code => code === '30026' ? {
    id: 224, code, name: 'Proveedor de prueba', accountCode: '2001001', terms: 30, currency: 2, exchangeRate,
  } : null, manual, storage);
  const allowedToken = 'a'.repeat(43);
  const deniedToken = 'b'.repeat(43);
  const authorize = async (token?: string) => {
    if (token !== allowedToken) throw new ApplicationError('Permiso de prueba', 'POLICY_LIABILITY_FORBIDDEN', token ? 403 : 401);
    return { id: 'permiso-prueba', legacyId: 21 };
  };
  const app = express().use(express.json()).use('/api', postgresWriteBoundary)
    .use('/api/accounting/policies', createPolicyLiabilityRouter(duplicate, authorize))
    .use('/api/accounting/policies', createManualPolicyRouter(manual, async (id, req) => {
      if (!await storage.hasLiability(id)) return;
      requireSessionOrigin(req);
      await authorize(sessionToken(req));
    })).use(errorHandler);
  const origin = 'http://localhost:5173';
  const path = `/api/accounting/policies/${policy.id}/actions/duplicate-liability`;
  const draft = { date: '2025-02-21', amount: 116.08, supplierCode: '30026', reference: '2611268767' };
  const cookies = (token = allowedToken) => `${cookieName}=${token}`;
  const review = (input = draft) => request(app).get(`${path}/preview`).query(input).set('Cookie', cookies());
  const confirm = (input: object, token = allowedToken) => request(app).post(path).set('Cookie', cookies(token))
    .set('Host', 'localhost:5173').set('Origin', origin).send(input);
  const previousUrl = env.NEON_DATABASE_URL;
  env.NEON_DATABASE_URL = 'postgres://fixture@127.0.0.1:1/never-connect';
  try {
    await request(app).get(path).expect(401);
    await request(app).get(path).set('Cookie', cookies(deniedToken)).expect(403);
    await request(app).get(path).set('Cookie', cookies()).expect(200);
    const unevenDraft = { ...draft, amount: 58.04 };
    const uneven = (await review(unevenDraft).expect(200)).body.data;
    expect(uneven).toMatchObject({
      canConfirm: false, totals: { debit: 58.05, credit: 58.04 },
      payable: { amount: 58.04, subtotal: 50.03, tax: 8.01, dueDate: '2025-03-23', supplier: { currency: 2, exchangeRate } },
    });
    await confirm({ ...unevenDraft, revision: uneven.revision, requestKey: randomUUID(), confirmed: true }).expect(422);
    await review({ ...draft, supplierCode: '99999' }).expect(422);
    const preview = (await review().expect(200)).body.data;
    expect(preview).toMatchObject({ canConfirm: true, totals: { debit: 116.08, credit: 116.08 } });
    const input = { ...draft, revision: preview.revision, requestKey: randomUUID(), confirmed: true };
    await confirm(input, deniedToken).expect(403);
    await confirm(input).set('Origin', 'http://other.example').expect(403);
    exchangeRate = 21;
    await confirm(input).expect(409);
    exchangeRate = 20.4722;

    failAudit = true;
    await confirm(input).expect(503);
    expect((await db.query(`SELECT (SELECT count(*)::int FROM tuvansa.manual_accounting_policies) AS policies,
      (SELECT count(*)::int FROM tuvansa.manual_accounting_policy_lines) AS lines,
      (SELECT count(*)::int FROM tuvansa.manual_policy_liabilities) AS liabilities`)).rows)
      .toEqual([{ policies: 0, lines: 0, liabilities: 0 }]);
    failAudit = false;

    const repeated = await Promise.all([confirm(input), confirm(input)]);
    expect(repeated.map(item => item.status)).toEqual([201, 201]);
    const saved = repeated[0]!.body.data;
    expect(repeated[1]!.body.data).toEqual(saved);
    expect(saved).toMatchObject({ applied: true, origin: 'DUPPAS', totals: { debit: 116.08, credit: 116.08 } });
    await confirm({ ...input, requestKey: randomUUID() }).expect(409);
    const client = await connect();
    const sql = await localPurchasePayablesSql(client);
    client.release();
    const chargeSql = `SELECT id::float8,principal::float8,currency_id,due_at::text,policy_number,supplier_id::float8,can_pay,cancelled
      FROM (${sql}) AS charges`;
    const charge = { id: saved.id, principal: 116.08, currency_id: 2, due_at: '2025-03-23', policy_number: saved.number,
      supplier_id: 224, can_pay: false, cancelled: false };
    expect((await db.query(chargeSql)).rows).toEqual([charge]);

    const local = `/api/accounting/policies/${saved.id}`;
    const cancel = { requestKey: randomUUID(), revision: saved.manual.revision, confirmed: true };
    const write = (token: string) => request(app).delete(local).set('Cookie', cookies(token))
      .set('Host', 'localhost:5173').set('Origin', origin).send(cancel);
    await write(deniedToken).expect(403);
    await request(app).post(`${local}/actions/unapply`).send(cancel).expect(409);
    const cancelled = (await write(allowedToken).expect(200)).body.data;
    expect(cancelled).toMatchObject({ applied: false, manual: { canceled: true } });
    expect((await write(allowedToken).expect(200)).body.data).toEqual(cancelled);
    expect((await db.query(chargeSql)).rows).toEqual([{ ...charge, cancelled: true }]);
  } finally {
    env.NEON_DATABASE_URL = previousUrl;
    await db.close();
  }
}, 30_000);
