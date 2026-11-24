import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import express from 'express';
import request from 'supertest';
import { expect, it } from 'vitest';
import { ManageManualPolicy } from '../src/modules/accounting/policies/application/use-cases/manage-manual-policy.js';
import type { ManualPolicyAccount, ManualPolicyReferences } from '../src/modules/accounting/policies/domain/datasources/manual-policy-data-source.js';
import { activeManualPolicyLines, manualPolicyAffectsAccount } from '../src/modules/accounting/policies/infrastructure/datasources/manual-policy-reads.js';
import { PostgresManualPolicies } from '../src/modules/accounting/policies/infrastructure/datasources/postgres-manual-policies.js';
import { createManualPolicyRouter } from '../src/modules/accounting/policies/presentation/http/manual-policy-routes.js';
import { PostgresBankReconciliations } from '../src/modules/treasury/banking/infrastructure/datasources/postgres-bank-reconciliations.js';
import type { PostgresConnectionFactory } from '../src/shared/infrastructure/database/postgres-pool.js';
import { errorHandler } from '../src/shared/infrastructure/http/error-handler.js';

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
