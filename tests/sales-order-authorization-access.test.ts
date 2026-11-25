import { createHash } from 'node:crypto';
import { beforeEach, expect, it, vi } from 'vitest';
import { MysqlOrderAuthorizationAccess } from '../src/modules/sales/orders/infrastructure/datasources/mysql-order-authorization-access.js';

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('../src/shared/infrastructure/database/legacy-mysql-pool.js', () => ({ legacyMysqlPool: { execute } }));

const credential = '2'.repeat(64);
const userId = 37;
const access = new MysqlOrderAuthorizationAccess([{ userId, sha256: createHash('sha256').update(credential).digest('hex') }]);

beforeEach(() => { execute.mockReset(); });

it('requires a registered credential before reading the active user or permissions', async () => {
  await expect(new MysqlOrderAuthorizationAccess([]).verify(credential))
    .rejects.toMatchObject({ code: 'ORDER_APPROVER_NOT_CONFIGURED', statusCode: 503 });
  await expect(access.verify(undefined)).rejects.toMatchObject({ code: 'ORDER_APPROVER_REQUIRED', statusCode: 401 });
  await expect(access.verify('f'.repeat(64))).rejects.toMatchObject({ code: 'ORDER_APPROVER_REQUIRED', statusCode: 401 });
  expect(execute).not.toHaveBeenCalled();
});

it('reads MPED5 for the active user group and returns the registered identity', async () => {
  execute.mockResolvedValueOnce([[{ groupId: 21 }]]).mockResolvedValueOnce([[{ allowed: 1, requiresSupervisor: 0 }]]);
  await expect(access.verify(credential)).resolves.toBe(userId);
  expect(execute).toHaveBeenNthCalledWith(1, expect.stringContaining('USRMULTICIA IN (0,1)'), [userId]);
  expect(execute).toHaveBeenNthCalledWith(2, expect.stringContaining('HUSER21<>0'), ['MPED5']);
});

it('rejects a missing user, a denied permission and an authorization that requires a supervisor', async () => {
  execute.mockResolvedValueOnce([[]]);
  await expect(access.verify(credential)).rejects.toMatchObject({ code: 'ORDER_APPROVER_FORBIDDEN', statusCode: 403 });
  execute.mockResolvedValueOnce([[{ groupId: 41 }]]).mockResolvedValueOnce([[{ allowed: 0, requiresSupervisor: 0 }]]);
  await expect(access.verify(credential)).rejects.toMatchObject({ code: 'ORDER_APPROVER_FORBIDDEN', statusCode: 403 });
  expect(execute).toHaveBeenLastCalledWith(expect.stringContaining('HUSER41<>0'), ['MPED5']);
  execute.mockResolvedValueOnce([[{ groupId: 0 }]]).mockResolvedValueOnce([[{ allowed: 1, requiresSupervisor: 1 }]]);
  await expect(access.verify(credential)).rejects.toMatchObject({ code: 'ORDER_SUPERVISOR_REQUIRED', statusCode: 403 });
});
