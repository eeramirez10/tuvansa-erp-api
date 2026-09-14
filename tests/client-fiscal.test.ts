import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { Pool } from 'mysql2/promise';
import { ClientFiscalUseCases } from '../src/modules/accounts-receivable/clients/application/use-cases/client-fiscal.js';
import { ClientFiscalController, createClientFiscalRouter } from '../src/modules/accounts-receivable/clients/presentation/http/client-fiscal-controller.js';
import { errorHandler } from '../src/shared/infrastructure/http/error-handler.js';
import { UnconfiguredClientFiscalVerificationProvider } from '../src/modules/accounts-receivable/clients/infrastructure/services/unconfigured-client-fiscal-verification-provider.js';
import type { ClientFiscalVerificationProvider } from '../src/modules/accounts-receivable/clients/domain/services/client-fiscal-verification-provider.js';
import { LegacyMysqlClientFiscalDataSource, parseCapitalRegimes } from '../src/modules/accounts-receivable/clients/infrastructure/datasources/legacy-mysql-client-fiscal-data-source.js';

vi.mock('../src/shared/infrastructure/database/legacy-mysql-pool.js', () => ({ legacyMysqlPool: {} }));

function fixture(provider: ClientFiscalVerificationProvider = new UnconfiguredClientFiscalVerificationProvider()) {
  const row = { CLISEQ: 42, CLICOD: 'TEST', CLIRFC: 'AAA010101AAA', CLINOM: 'CLIENTE PRUEBA', CLICP: '01000', CLIREGIMEN: '601', CLICFDI4CS: 123 };
  const execute = vi.fn(async (sql: string, values?: unknown[]) => {
    if (sql.startsWith('UPDATE')) {
      Object.assign(row, { CLIRFC: values![0], CLINOM: values![1], CLICP: values![2], CLIREGIMEN: values![3], CLICFDI4CS: 0 });
      return [{ affectedRows: 1 }, []];
    }
    return [sql.includes('FROM fyg') ? [{ payload: Buffer.from('SA|~|~Sociedad||') }] : [{ ...row }], []];
  });
  const db = { execute, beginTransaction: vi.fn(), commit: vi.fn(), rollback: vi.fn(), release: vi.fn() };
  const pool = { execute, getConnection: async () => db } as unknown as Pool;
  const source = new LegacyMysqlClientFiscalDataSource(pool);
  const app = express();
  app.use(express.json());
  app.use('/clients/:clientId/actions/fiscal-verification', createClientFiscalRouter(new ClientFiscalController(new ClientFiscalUseCases(source, provider))));
  app.use(errorHandler);
  return { app, source, db, row };
}

describe('Client fiscal editing', () => {
  it('loads without writes and rejects verification without inventing a checksum', async () => {
    const { app, db } = fixture();
    const base = '/clients/42/actions/fiscal-verification';
    const loaded = await request(app).get(base).expect(200);
    expect(loaded.body.data.verificationAvailable).toBe(false);
    await request(app).post(`${base}/verify`).send({}).expect(501);
    expect(db.execute.mock.calls.every(([sql]) => sql.startsWith('SELECT'))).toBe(true);
  });
  it('saves parameterized fields, invalidates the marker, and commits', async () => {
    const { source, db } = fixture();
    const original = (await source.find(42))!;
    const values = { ...original.values, name: "PRUEBA ' ?" };
    const result = await source.save(42, { values, expectedVersion: original.version });
    expect(result.status).toBe('saved');
    if (result.status === 'saved') {
      expect(result.data.verification).toBe('pending');
      expect(result.data.version).not.toBe(original.version);
    }
    const update = db.execute.mock.calls.find(([sql]) => sql.startsWith('UPDATE'))!;
    expect(update[0]).not.toContain(values.name);
    expect(update[1]).toEqual([values.taxId, values.name, values.postalCode, values.fiscalRegime, 42]);
    expect(db.commit).toHaveBeenCalledOnce();
    expect(db.release).toHaveBeenCalledOnce();
  });
  it('preserves an unchanged marker and rejects stale forms', async () => {
    const { source, db, row } = fixture();
    const original = (await source.find(42))!;
    await source.save(42, { values: original.values, expectedVersion: original.version });
    expect(row.CLICFDI4CS).toBe(123);
    expect(db.execute.mock.calls.some(([sql]) => sql.startsWith('UPDATE'))).toBe(false);
    row.CLINOM = 'CONCURRENT CHANGE';
    expect(await source.save(42, { values: original.values, expectedVersion: original.version })).toEqual({ status: 'conflict' });
    expect(db.rollback).toHaveBeenCalledOnce();
  });
  it('rolls back and releases the connection on a database error', async () => {
    const { source, db } = fixture();
    const original = (await source.find(42))!;
    db.execute.mockRejectedValueOnce(new Error('offline'));
    await expect(source.save(42, { values: original.values, expectedVersion: original.version })).rejects.toThrow('offline');
    expect(db.rollback).toHaveBeenCalledOnce();
    expect(db.release).toHaveBeenCalledOnce();
    expect(db.commit).not.toHaveBeenCalled();
  });
  it('rejects checksum overposting and stale HTTP saves', async () => {
    const { app, source, row } = fixture();
    const original = (await source.find(42))!;
    const body = { values: original.values, expectedVersion: original.version };
    const path = '/clients/42/actions/fiscal-verification';
    await request(app).patch(path).send({ ...body, CLICFDI4CS: 999 }).expect(400);
    row.CLINOM = 'CHANGED';
    await request(app).patch(path).send(body).expect(409);
    await request(app).get('/clients/invalid/actions/fiscal-verification').expect(400);
  });
  it('retains the no-society row and ignores malformed/duplicate catalog rows', () => {
    expect(parseCapitalRegimes('|~|~SIN SOCIEDAD||SA|~|~Sociedad||SA|~|~Duplicado||bad')).toEqual([
      { code: '', description: 'SIN SOCIEDAD' }, { code: 'SA', description: 'Sociedad' },
    ]);
  });
});

describe('Future fiscal provider integration', () => {
  const path = '/clients/42/actions/fiscal-verification';

  it('reports not configured without making a successful verification claim', async () => {
    const { app } = fixture();
    const response = await request(app).post(`${path}/verify`).send({}).expect(501);
    expect(response.body.error.code).toBe('FISCAL_VERIFICATION_UNAVAILABLE');
    expect(response.body.error.message).toContain('integración');
  });

  it('passes only fiscal values and separates provider validation from legacy synchronization', async () => {
    const verify = vi.fn<ClientFiscalVerificationProvider['verify']>().mockResolvedValue({ status: 'validated' });
    const { app, db, row } = fixture({ configured: true, verify });
    const loaded = await request(app).get(path).expect(200);
    expect(loaded.body.data.verificationAvailable).toBe(true);
    const response = await request(app).post(`${path}/verify`).send({}).expect(200);
    expect(verify).toHaveBeenCalledWith(loaded.body.data.values);
    expect(response.body.data).toEqual({
      clientId: 42, version: loaded.body.data.version, status: 'provider-validated', legacySync: 'pending',
    });
    expect(response.body.message).toContain('PROSCAI sigue pendiente');
    expect(db.execute.mock.calls.every(([sql]) => sql.startsWith('SELECT'))).toBe(true);
    expect(row.CLICFDI4CS).toBe(123);
  });

  it('maps a rejected validation without saving', async () => {
    const { app, db } = fixture({ configured: true, verify: async () => ({ status: 'rejected' }) });
    const response = await request(app).post(`${path}/verify`).send({}).expect(422);
    expect(response.body.error.code).toBe('FISCAL_DATA_REJECTED');
    expect(db.execute.mock.calls.every(([sql]) => sql.startsWith('SELECT'))).toBe(true);
  });

  it('maps temporary unavailability without exposing transport details', async () => {
    const { app } = fixture({ configured: true, verify: async () => ({ status: 'unavailable', reason: 'temporary' }) });
    const response = await request(app).post(`${path}/verify`).send({}).expect(503);
    expect(response.body.error.code).toBe('FISCAL_PROVIDER_UNAVAILABLE');
  });

  it('sanitizes exceptions from the future adapter', async () => {
    const { app } = fixture({ configured: true, verify: async () => { throw new Error('private transport detail'); } });
    const response = await request(app).post(`${path}/verify`).send({}).expect(503);
    expect(JSON.stringify(response.body)).not.toContain('private transport detail');
  });

  it('rejects a result when the client changed while awaiting the provider', async () => {
    const verify = vi.fn<ClientFiscalVerificationProvider['verify']>();
    const { app, row } = fixture({ configured: true, verify });
    verify.mockImplementation(async () => { row.CLINOM = 'CONCURRENT EDIT'; return { status: 'validated' }; });
    const response = await request(app).post(`${path}/verify`).send({}).expect(409);
    expect(response.body.error.code).toBe('FISCAL_DATA_CHANGED');
    expect(row.CLICFDI4CS).toBe(123);
  });

  it('does not treat an unknown provider status as success', async () => {
    const verify = vi.fn().mockResolvedValue({ status: 'unexpected' });
    const { app } = fixture({ configured: true, verify });
    await request(app).post(`${path}/verify`).send({}).expect(502);
  });
});
