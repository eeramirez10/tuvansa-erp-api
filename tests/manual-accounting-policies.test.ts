import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import express from 'express';
import request from 'supertest';
import { expect, it } from 'vitest';
import { env } from '../src/config/env.js';
import { ManageManualPolicy } from '../src/modules/accounting/policies/application/use-cases/manage-manual-policy.js';
import type { ManualPolicyAccount, ManualPolicyReferences } from '../src/modules/accounting/policies/domain/datasources/manual-policy-data-source.js';
import { AccountingPolicy, type AccountingPolicyProps } from '../src/modules/accounting/policies/domain/entities/accounting-policy.js';
import { activeManualPolicyLines, manualPolicyAffectsAccount, manualPolicyProps } from '../src/modules/accounting/policies/infrastructure/datasources/manual-policy-reads.js';
import { PostgresManualPolicies } from '../src/modules/accounting/policies/infrastructure/datasources/postgres-manual-policies.js';
import { createManualPolicyRouter } from '../src/modules/accounting/policies/presentation/http/manual-policy-routes.js';
import { PostgresBankReconciliations } from '../src/modules/treasury/banking/infrastructure/datasources/postgres-bank-reconciliations.js';
import type { PostgresConnectionFactory } from '../src/shared/infrastructure/database/postgres-pool.js';
import { errorHandler } from '../src/shared/infrastructure/http/error-handler.js';
import { postgresWriteBoundary } from '../src/shared/infrastructure/http/postgres-write-boundary.js';

it('saves policy comments on an unapplied journal without replacing ledger lines', async () => {
  const db = new PGlite();
  const connect: PostgresConnectionFactory = async () => ({
    async query<T extends object>(sql: string, values?: unknown[]) {
      if (values) return db.query<T>(sql, values);
      return { rows: ((await db.exec(sql)).at(-1)?.rows ?? []) as T[] };
    },
    release() {},
  });
  const storage = new PostgresManualPolicies(connect, () => true);
  const references: ManualPolicyReferences = {
    settings: async () => ({ fiscalStart: '2025-01-01', fiscalEnd: '2025-12-31', periodYear: 2025, levels: [], costCenters: [] }),
    search: async () => [],
    accounts: async () => new Map(),
  };
  const previousUrl = env.NEON_DATABASE_URL;
  env.NEON_DATABASE_URL = 'postgres://fixture@127.0.0.1:1/never-connect';
  try {
    const account = { id: 10, code: '1115001', name: 'Inventario', type: 2, nature: 0 };
    const created = await storage.create(
      { requestKey: randomUUID(), date: '2025-02-02', concept: 'Concepto anterior', beneficiary: '', family: '', lines: [] },
      [
        { account, parents: [], debit: 20, credit: 0, costCenter: 0, reference: 'Entrada' },
        { account: { ...account, id: 11, code: '2001001' }, parents: [], debit: 0, credit: 20, costCenter: 0, reference: 'Contrapartida' },
      ],
      '0'.repeat(64), async () => undefined,
    );
    const manual = new ManageManualPolicy(references, storage, {
      findById: async (id) => {
        if (id === 42) {
          const historical = { ...created, id, applied: false };
          delete historical.manual;
          return AccountingPolicy.create(historical);
        }
        const local = await storage.find(id);
        return local && AccountingPolicy.create(manualPolicyProps(local));
      },
    }, async () => ['Nota histórica', '', '', '', '', '']);
    const app = express().use(express.json()).use(postgresWriteBoundary)
      .use('/accounting/policies', createManualPolicyRouter(manual)).use(errorHandler);
    const path = `/accounting/policies/${created.id}/actions`;
    const preview = (await request(app).get(`${path}/comments`).expect(200)).body.data;
    expect(preview).toMatchObject({ applied: true, canWrite: false, revision: 1 });
    const fields = { ...preview.fields, date: '2025-02-18', concept: 'Concepto editado', cheque: 'REF-1',
      postDate: '2025-02-20', comments: ['Nota nueva', '', '', '', 'Línea A\nLínea B', ''] };
    const input = { requestKey: randomUUID(), revision: 1, fields };
    await request(app).patch(`${path}/comments`).send(input).expect(409);
    await request(app).post(`${path}/unapply`).send({ requestKey: randomUUID(), confirmed: true, revision: 1 }).expect(200);
    await request(app).patch(`${path}/comments`).send(input).expect(409);
    expect((await request(app).get(`${path}/comments`).expect(200)).body.data).toMatchObject({ canWrite: true, revision: 2 });
    const update = { ...input, revision: 2 };
    await request(app).patch(`${path}/comments`).send({ ...update, fields: { ...fields, date: '2025-03-01' } }).expect(422);
    const saved = (await request(app).patch(`${path}/comments`).send(update).expect(200)).body.data;
    expect(saved).toMatchObject({ ...fields, applied: false, manual: { revision: 3 }, movements: created.movements });
    expect((await request(app).patch(`${path}/comments`).send(update).expect(200)).body.data).toEqual(saved);
    expect((await request(app).get(`${path}/comments`).expect(200)).body.data).toMatchObject({ fields, revision: 3 });
    expect((await request(app).get('/accounting/policies/42/actions/comments').expect(200)).body.data).toMatchObject({
      canWrite: false, fields: { comments: ['Nota histórica', '', '', '', '', ''] },
    });
    expect((await db.query(`SELECT revision,action FROM tuvansa.manual_accounting_policy_changes ORDER BY revision`)).rows)
      .toEqual([{ revision: 1, action: 'create' }, { revision: 2, action: 'unapply' }, { revision: 3, action: 'comments' }]);
  } finally {
    env.NEON_DATABASE_URL = previousUrl;
    await db.close();
  }
}, 30000);

it('applies, unapplies, edits, reapplies and cancels manual journals, preserving reconciled lines and history', async () => {
  const db = new PGlite();
  const connect: PostgresConnectionFactory = async () => ({
    async query<T extends object>(sql: string, values?: unknown[]) {
      if (values) return db.query<T>(sql, values);
      const result = await db.exec(sql);
      return { rows: (result.at(-1)?.rows ?? []) as T[] };
    },
    release() {},
  });
  const bank: ManualPolicyAccount = { id: 6610, code: '1102100001', name: 'Banco', type: 0, nature: 0 };
  const parent: ManualPolicyAccount = { id: 6608, code: '1102', name: 'Grupo de bancos', type: 0, nature: 0 };
  const liability: ManualPolicyAccount = { id: 6908, code: '2005002001', name: 'Contrapartida', type: 2, nature: 1 };
  const chart = new Map([bank, liability].map((account) => [account.code, { account, parents: account.type === 0 ? [parent] : [] }]));
  const refs: ManualPolicyReferences = {
    settings: async () => ({ fiscalStart: '2025-01-01', fiscalEnd: '2025-12-31', periodYear: 2024, levels: [4, 7, 10],
      costCenters: [{ code: 0, name: 'Sin centro' }, { code: 1, name: 'México' }] }),
    search: async () => [bank, liability],
    accounts: async () => chart,
  };
  const storage = new PostgresManualPolicies(connect, () => true);
  const app = express().use(express.json()).use('/policies', createManualPolicyRouter(new ManageManualPolicy(refs, storage))).use(errorHandler);
  const input = {
    requestKey: randomUUID(), date: '2025-11-06', concept: 'Diario web', beneficiary: 'Prueba', family: '',
    lines: [{ accountCode: bank.code, debit: 145.16, credit: 0, costCenter: 1, reference: 'A' },
      { accountCode: liability.code, debit: 0, credit: 145.16, costCenter: 1, reference: 'B' }],
  };
  const action = (revision: number) => ({ requestKey: randomUUID(), revision, confirmed: true });
  const currentBalance = async (id: number) => (await db.query<{ balance: number }>(
    `SELECT coalesce(sum(l.debit-l.credit),0)::float8 AS balance ${activeManualPolicyLines} WHERE ${manualPolicyAffectsAccount}`, [id],
  )).rows[0]!.balance;
  try {
    const options = await request(app).get('/policies/capture').expect(200);
    expect(options.body.data).toMatchObject({ canWrite: true, defaults: { type: '3' }, fiscalStart: '2025-01-01' });
    expect((await db.query("SELECT to_regclass('tuvansa.manual_accounting_policies') AS table_name")).rows).toEqual([{ table_name: null }]);
    await request(app).post('/policies').send({ ...input, date: '2026-01-01' }).expect(422);
    await request(app).post('/policies').send({ ...input, lines: [{ ...input.lines[0], debit: 100 }, input.lines[1]] }).expect(422);
    await request(app).post('/policies').send({ ...input, lines: [{ ...input.lines[0], accountCode: parent.code }, input.lines[1]] }).expect(422);

    const { body: { data: created } } = await request(app).post('/policies').send(input).expect(201);
    expect(created).toMatchObject({ id: 7990000000000, number: '3JW00000001', applied: true,
      manual: { revision: 1, canceled: false, reconciled: false }, totals: { debit: 145.16, credit: 145.16, difference: 0 } });
    expect((await request(app).post('/policies').send({ ...input, requestKey: input.requestKey.toUpperCase() }).expect(201)).body.data).toEqual(created);
    expect(await currentBalance(bank.id)).toBe(145.16);
    expect(await currentBalance(parent.id)).toBe(145.16);
    const target = `/policies/${created.id}`;
    const edited = { ...input, requestKey: randomUUID(), revision: 1, concept: 'Diario corregido' };
    await request(app).patch(target).send(edited).expect(409);
    await request(app).post(`${target}/actions/unapply`).send(action(1)).expect(200);
    expect(await currentBalance(bank.id)).toBe(0);
    const preview = await request(app).get(`${target}/actions/manual`).expect(200);
    expect(preview.body.data).toMatchObject({ revision: 2, canEdit: true, canApply: true, canUnapply: false, canDelete: true });
    await request(app).patch(target).send(edited).expect(409);
    await request(app).patch(target).send({ ...edited, revision: 2 }).expect(200);
    const { body: { data: applied } } = await request(app).post(`${target}/actions/apply`).send(action(3)).expect(200);
    expect(applied).toMatchObject({ applied: true, concept: edited.concept, manual: { revision: 4 } });

    const reconciler = new PostgresBankReconciliations(connect, () => true);
    await reconciler.commit({ companyId: 1, bankAccountId: bank.id, fingerprint: 'c'.repeat(64),
      bankOpeningBalance: async () => 0, input: { requestKey: randomUUID(), movementIds: [applied.movements[0].id],
        statementDate: '2025-11-07', expectedBankBalance: 0, statementBalance: 145.16 } });
    expect(await storage.find(created.id)).toMatchObject({ reconciled: true });
    await request(app).post(`${target}/actions/unapply`).send(action(4)).expect(409);
    await request(app).delete(target).send(action(4)).expect(409);
    await request(app).delete('/policies/6700000000000').send(action(1)).expect(404);

    const second = (await request(app).post('/policies').send({ ...input, requestKey: randomUUID() }).expect(201)).body.data;
    const cancelInput = action(1);
    const canceled = (await request(app).delete(`/policies/${second.id}`).send(cancelInput).expect(200)).body.data;
    expect(canceled).toMatchObject({ applied: false, manual: { revision: 2, canceled: true }, totals: { debit: 145.16, credit: 145.16 } });
    expect((await request(app).delete(`/policies/${second.id}`).send(cancelInput).expect(200)).body.data).toEqual(canceled);
    expect(await currentBalance(bank.id)).toBe(145.16);
    expect((await db.query('SELECT revision,action FROM tuvansa.manual_accounting_policy_changes WHERE policy_id=$1 ORDER BY revision', [created.id])).rows)
      .toEqual([{ revision: 1, action: 'create' }, { revision: 2, action: 'unapply' }, { revision: 3, action: 'change' }, { revision: 4, action: 'apply' }]);
  } finally { await db.close(); }
}, 20000);

it('duplicates an ordinary policy through the write boundary and applies only the new journal once', async () => {
  const db = new PGlite();
  const connect: PostgresConnectionFactory = async () => ({
    async query<T extends object>(sql: string, values?: unknown[]) {
      if (values) return db.query<T>(sql, values);
      const results = await db.exec(sql);
      return { rows: (results.at(-1)?.rows ?? []) as T[] };
    },
    release() {},
  });
  const account: ManualPolicyAccount = { id: 10, code: '1115001', name: 'Almacén', type: 2, nature: 0 };
  const payable: ManualPolicyAccount = { id: 11, code: '2001001', name: 'Proveedores', type: 2, nature: 1 };
  const settings = { fiscalStart: '2025-01-01', fiscalEnd: '2025-12-31', periodYear: 2025, levels: [4, 7],
    costCenters: [{ code: 1, name: 'México' }] };
  const references: ManualPolicyReferences = {
    settings: async () => settings,
    search: async () => [account, payable],
    accounts: async (codes) => new Map([account, payable].filter(({ code }) => codes.includes(code))
      .map((row) => [row.code, { account: row, parents: [] }])),
  };
  const source: AccountingPolicyProps = {
    id: 25, number: '312502-0010', company: 1, date: '2025-02-01', cheque: 'RA09186',
    beneficiary: 'Proveedor de la póliza', concept: 'Recepción RA09186', family: 'COMPRAS', applied: true,
    origin: '', amountInWords: '', userId: 0, report: '', auditAt: null, postDate: null, classifications: ['', ''], usedAt: null,
    exchangeRate: 1, totals: { debit: 130.66, credit: 130.66, difference: 0 },
    movements: [
      { id: 50, accountId: account.id, accountCode: account.code, accountName: account.name, accountType: account.type,
        debit: 130.66, credit: 0, reference: 'COMPRA', exchangeRate: 1, costCenter: 1, reconciled: false },
      { id: 51, accountId: payable.id, accountCode: payable.code, accountName: payable.name, accountType: payable.type,
        debit: 0, credit: 130.66, reference: 'AP', exchangeRate: 1, costCenter: 1, reconciled: true },
    ],
  };
  const storage = new PostgresManualPolicies(connect, () => true);
  const manual = new ManageManualPolicy(references, storage, { findById: async (id) => {
    if (id === 25) return AccountingPolicy.create(source);
    if (id === 26) return AccountingPolicy.create({ ...source, id, number: '112502-0010' });
    const local = await storage.find(id);
    return local && AccountingPolicy.create(manualPolicyProps(local));
  } });
  const app = express().use(express.json()).use(postgresWriteBoundary)
    .use('/accounting/policies', createManualPolicyRouter(manual)).use(errorHandler);
  const path = '/accounting/policies/25/actions/duplicate';
  const previousUrl = env.NEON_DATABASE_URL;
  // Only the boundary reads the URL; the storage above uses the isolated PGlite instance.
  env.NEON_DATABASE_URL = 'postgres://fixture@127.0.0.1:1/never-connect';
  try {
    const preview = (await request(app).get(path).expect(200)).body.data;
    expect(preview).toMatchObject({ policy: { id: 25, number: source.number }, fiscalStart: settings.fiscalStart,
      fiscalEnd: settings.fiscalEnd, canWrite: true, revision: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect((await request(app).get('/accounting/policies/26/actions/duplicate').expect(200)).body.data).toMatchObject({ canWrite: false });
    const input = { date: '2025-02-04', requestKey: randomUUID(), revision: preview.revision, confirmed: true };
    await request(app).post(path).send({ ...input, confirmed: false }).expect(400);
    await request(app).post(path).send({ ...input, date: '2026-01-01' }).expect(422);
    const original = source.concept;
    source.concept = 'Cambio de origen';
    await request(app).post(path).send(input).expect(409);
    source.concept = original;
    const duplicate = (await request(app).post(path).send(input).expect(201)).body.data;
    expect(duplicate).toMatchObject({ number: '3JW00000001', date: input.date, applied: true,
      beneficiary: source.beneficiary, concept: source.concept, family: source.family, cheque: '', totals: source.totals,
      movements: [
        { accountCode: account.code, debit: 130.66, credit: 0, reference: 'COMPRA', costCenter: 1, reconciled: false },
        { accountCode: payable.code, debit: 0, credit: 130.66, reference: 'AP', costCenter: 1, reconciled: false },
      ],
    });
    expect(source).toMatchObject({ cheque: 'RA09186', movements: [{ id: 50 }, { id: 51, reconciled: true }] });
    expect((await request(app).post(path).send(input).expect(201)).body.data).toEqual(duplicate);
    await request(app).post(path).send({ ...input, date: '2025-02-05' }).expect(409);
    const { rows } = await db.query(`SELECT sum(debit)::float8 AS debit, sum(credit)::float8 AS credit ${activeManualPolicyLines}`);
    expect(rows).toEqual([{ debit: 130.66, credit: 130.66 }]);

    const own = `/accounting/policies/${duplicate.id}/actions/duplicate`;
    const ownPreview = (await request(app).get(own).expect(200)).body.data;
    await request(app).post(own).send({ ...input, requestKey: randomUUID(), revision: ownPreview.revision }).expect(201);
    expect((await db.query('SELECT count(*)::int AS copies FROM tuvansa.manual_accounting_policies')).rows).toEqual([{ copies: 2 }]);
    expect((await db.query("SELECT to_regclass('tuvansa.supplier_payments') AS payments")).rows).toEqual([{ payments: null }]);
  } finally {
    env.NEON_DATABASE_URL = previousUrl;
    await db.close();
  }
}, 20000);
