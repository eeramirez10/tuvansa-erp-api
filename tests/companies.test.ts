import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { env } from '../src/config/env.js';

vi.mock('../src/shared/infrastructure/database/legacy-mysql-pool.js', () => ({ legacyMysqlPool: {} }));

const app = createApp();
const baseUrl = `${env.API_PREFIX}/companies`;

describe('Selección de multicía', () => {
  it('lists the six companies in Omnis order and only enables México', async () => {
    const response = await request(app).get(baseUrl).expect(200);
    expect(response.body.data.map(({ id, alias, enabled }: {
      id: number;
      alias: string;
      enabled: boolean;
    }) => [id, alias, enabled])).toEqual([
      [1, 'MEXICO', true],
      [2, 'MONTERREY', false],
      [3, 'VERACRUZ', false],
      [4, 'MEXICALI', false],
      [5, 'QUERETARO', false],
      [6, 'CANCUN', false],
    ]);
  });

  it('returns the México context without permitting the browser to reuse a cached response', async () => {
    const response = await request(app).get(`${baseUrl}/1/context`).expect('Cache-Control', 'no-store').expect(200);
    expect(response.body.data).toEqual({
      company: { id: 1, alias: 'MEXICO', description: 'TUBERIA Y VALVULAS DEL NORTE, S.A. DE C.V.', enabled: true },
      databaseAlias: 'TUVANSA',
      warehouseCode: '01',
      locationId: 0,
    });
  });

  it.each([
    ['2', 403, 'COMPANY_DISABLED'],
    ['7', 404, 'COMPANY_NOT_FOUND'],
    ['-1', 400, 'VALIDATION_ERROR'],
    ['1.0', 400, 'VALIDATION_ERROR'],
    ['01', 400, 'VALIDATION_ERROR'],
  ])('rejects company context %s with %s', async (id, status, code) => {
    const response = await request(app).get(`${baseUrl}/${id}/context`).expect(status);
    expect(response.body.error.code).toBe(code);
  });
});
