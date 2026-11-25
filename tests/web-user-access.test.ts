import { PGlite } from '@electric-sql/pglite';
import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LegacyUserDirectory, NativeUser } from '../src/modules/general-data/users/domain/user-directory.js';
import { PostgresWebAccess } from '../src/modules/general-data/users/infrastructure/postgres-web-access.js';
import { hashPassword, tokenDigest } from '../src/modules/general-data/users/infrastructure/web-credentials.js';
import { createUserDirectoryRouter, createWebSessionRouter } from '../src/modules/general-data/users/presentation/web-access-router.js';
import type { PostgresConnectionFactory } from '../src/shared/infrastructure/database/postgres-pool.js';
import { errorHandler } from '../src/shared/infrastructure/http/error-handler.js';
import { postgresWriteBoundary } from '../src/shared/infrastructure/http/postgres-write-boundary.js';

const db = new PGlite();
let available = Promise.resolve();
const connect: PostgresConnectionFactory = async () => {
  const ready = available;
  let release!: () => void;
  available = new Promise<void>(resolve => { release = resolve; });
  await ready;
  return {
    query: async <T extends object>(sql: string, values?: unknown[]) => {
      if (values) return db.query<T>(sql, values);
      return { rows: (await db.exec(sql)).at(-1)?.rows as T[] ?? [] };
    },
    release,
  };
};
const admin: NativeUser = { legacyId: 1, identification: 'admin', name: 'Administrador de prueba', group: 0, active: true, shared: false };
const approver: NativeUser = {
  legacyId: 21, identification: 'comprueba', name: 'Usuario de German', group: 18, active: true, shared: true,
  details: {
    company: 1, department: 2, multiCompany: 0, notes: 'Perfil de prueba',
    hideCosts: true, hideBalances: false, ownCustomersOnly: true,
    parameter: null, printer: null, labelPrinter: null, supplierClassifiers: null,
    captureFrom: '2026-01-01', captureUntil: null, store: '01', payrollNumber: null, position: null,
  },
};
const duplicate = { ...approver, legacyId: 25, identification: 'ADMIN', active: false };
let supervisorRequired = false;
const native: LegacyUserDirectory = {
  users: async () => [admin, approver, duplicate],
  user: async id => [admin, approver, duplicate].find(user => user.legacyId === id),
  permissions: async (group, keys) => [
    { key: 'INICIO13', label: 'Datos Generales', allowed: false, requiresSupervisor: false, module: 'Inicio' },
    { key: 'MCATALOGOS8', label: 'Usuarios', allowed: group === 0, requiresSupervisor: false, module: 'Catálogos' },
    { key: 'MPED5', label: 'Autorizar', allowed: group === 18, requiresSupervisor: supervisorRequired, module: 'Pedidos' },
    { key: 'SUP', label: 'Operación con firma', allowed: true, requiresSupervisor: true, module: 'Ventas' },
  ].filter(item => !keys || keys.includes(item.key)),
};
const access = new PostgresWebAccess(native, connect);
const app = express().use(express.json()).use('/api', postgresWriteBoundary)
  .use('/api/session', createWebSessionRouter(access))
  .use('/api/general-data', createUserDirectoryRouter(access)).use(errorHandler);
const route = '/api/general-data/users';
const groups = '/api/general-data/permission-groups';
const password = 'Pru6#1';
let adminCookie = '';
const cookieToken = (cookie: string) => cookie.split('=')[1]!;
const host = 'localhost:5173';
const origin = `http://${host}`;

function change(method: 'post' | 'patch' | 'delete', path: string, cookie?: string) {
  const operation = request(app)[method](path).set('Host', host).set('Origin', origin);
  return cookie ? operation.set('Cookie', cookie) : operation;
}

async function login(identification: string) {
  const response = await change('post', '/api/session').send({ identification, password }).expect(200);
  const cookies = response.headers['set-cookie'] as unknown as string[];
  expect(cookies[0]).toContain('HttpOnly');
  expect(cookies[0]).toContain('SameSite=Strict');
  return cookies[0]!.split(';')[0]!;
}

beforeAll(async () => {
  await expect(access.bootstrapAdministrator(1)).rejects.toMatchObject({ code: 'WEB_IDENTIFICATION_IN_USE' });
  const { token } = await access.bootstrapAdministrator(1, 'administrador-web');
  await expect(access.bootstrapAdministrator(21)).rejects.toMatchObject({ code: 'WEB_ADMIN_EXISTS' });
  await change('post', '/api/session/activation').send({ token, password: password.slice(0, -1) })
    .expect(400).expect(({ body }) => expect(body.error.code).toBe('VALIDATION_ERROR'));
  await change('post', '/api/session/activation').send({ token, password }).expect(204);
  await change('post', '/api/session/activation').send({ token, password }).expect(400);
  adminCookie = await login('ADMINISTRADOR-WEB');
}, 30_000);

afterAll(async () => { await db.close(); });

describe('Usuarios y permisos con PostgreSQL aislado', () => {
  it('protege el catálogo, filtra el directorio y conserva sólo datos de perfil', async () => {
    await request(app).get(route).expect(401);
    const result = await request(app).get(route).query({ search: 'german', group: 18, state: 'pending' }).set('Cookie', adminCookie).expect(200);
    expect(result.body.data).toMatchObject({ total: 1, items: [{ id: 'g-21', legacyId: 21, shared: true }] });
    expect(result.body.data.items[0]).not.toHaveProperty('password');
    expect(result.body.data.items[0]).not.toHaveProperty('legacyDetails');
    expect(result.headers['cache-control']).toBe('no-store');
    await change('post', route, adminCookie).set('Origin', 'https://otro.example').send({}).expect(403);
    const session = await request(app).get('/api/session').set('Cookie', adminCookie).expect(200);
    expect(session.body.data.capabilities).toEqual({ generalData: true, users: true, authorizeOrders: false });
    const raw = await db.query<{ digest: string }>('SELECT digest FROM tuvansa.web_sessions');
    expect(raw.rows).toContainEqual({ digest: tokenDigest(cookieToken(adminCookie)) });
    expect(raw.rows).not.toContainEqual({ digest: cookieToken(adminCookie) });
  });

  it('protege la ficha exacta y conserva la posición de los vecinos a través de páginas', async () => {
    await request(app).get(`${route}/g-21`).expect(401);
    const detail = await request(app).get(`${route}/g-21`).set('Cookie', adminCookie).expect(200);
    expect(detail.body.data).toMatchObject({ id: 'g-21', revision: 0, legacyDetails: approver.details, activationExpiresAt: null });
    expect(detail.body.data).not.toHaveProperty('password');
    expect(detail.headers['cache-control']).toBe('no-store');
    await request(app).get(`${route}/g-999`).set('Cookie', adminCookie).expect(404);

    const byGroup = (query: object) => request(app).get(route).query({ group: 18, limit: 1, ...query }).set('Cookie', adminCookie);
    const first = await byGroup({}).expect(200);
    expect(first.body.data).toMatchObject({ total: 2, items: [{ id: 'g-25' }] });
    const next = await byGroup({ anchor: 'g-25', direction: 'next' }).expect(200);
    expect(next.body.data).toMatchObject({ total: 2, position: 1, items: [{ id: 'g-21' }] });
    const previous = await byGroup({ anchor: 'g-21', direction: 'previous' }).expect(200);
    expect(previous.body.data).toMatchObject({ position: 0, items: [{ id: 'g-25' }] });
    const last = await byGroup({ anchor: 'g-21', direction: 'next' }).expect(200);
    expect(last.body.data).toEqual({ items: [], total: 2, position: null });
    await byGroup({ anchor: 'g-21' }).expect(400);
  });

  it('guarda las restricciones por usuario y las aplica sin volver a iniciar sesión', async () => {
    const profile = { identification: 'reglas-web', name: 'Reglas de prueba', group: 18, active: true, administrator: false };
    const settings = { hideCosts: true, hideBalances: true, ownCustomersOnly: true, classifier: 3, parameter: '201' };
    await change('post', route, adminCookie).send({ ...profile, settings: { ownCustomersOnly: true } })
      .expect(400).expect(({ body }) => expect(body.error.code).toBe('WEB_USER_CLIENT_SCOPE_REQUIRED'));
    const created = (await change('post', route, adminCookie).send({ ...profile, settings }).expect(201)).body.data;
    const path = `${route}/${created.id}`;
    const token = (await change('post', `${path}/activation`, adminCookie).send({ revision: 1 }).expect(200)).body.data.token;
    await change('post', '/api/session/activation').send({ token, password }).expect(204);
    const cookie = await login(profile.identification);
    const session = () => request(app).get('/api/session').set('Cookie', cookie).expect(200);
    expect((await session()).body.data.user.access).toMatchObject(settings);
    await change('patch', path, adminCookie).send({ ...profile, revision: 3, settings: { hideCosts: false } }).expect(200);
    expect((await session()).body.data.user.access).toMatchObject({ ...settings, hideCosts: false });
    expect((await request(app).get(path).set('Cookie', adminCookie).expect(200)).body.data.settings)
      .toMatchObject({ ...settings, hideCosts: false });
  });

  it('activa usuarios de German y comprueba MPED5 vigente en cada operación', async () => {
    const response = await change('post', `${route}/g-21/activation`, adminCookie).send({ revision: 0 }).expect(200);
    const { token } = response.body.data;
    const stored = await db.query<{ digest: string }>('SELECT digest FROM tuvansa.web_activations');
    expect(stored.rows).toContainEqual({ digest: tokenDigest(token) });
    const pending = await request(app).get(`${route}/g-21`).set('Cookie', adminCookie).expect(200);
    expect(Date.parse(pending.body.data.activationExpiresAt)).toBeGreaterThan(Date.now());
    expect(pending.body.data).not.toHaveProperty('token');
    await change('post', '/api/session/activation').send({ token, password }).expect(204);
    const approverCookie = await login('comprueba');
    await request(app).get(route).set('Cookie', approverCookie).expect(403);
    await request(app).get(`${route}/g-21`).set('Cookie', approverCookie).expect(403);
    const actor = () => access.orderActor(cookieToken(approverCookie));
    await expect(actor()).resolves.toMatchObject({ webUserId: 'g-21', userId: 21, userIdentification: 'comprueba' });
    const rewrite = (revision: number, allowed: boolean | null) => change('patch', `${groups}/18`, adminCookie)
      .send({ revision, changes: [{ key: 'MPED5', allowed }] });
    await rewrite(0, false).expect(200);
    await expect(actor()).rejects.toMatchObject({ code: 'ORDER_APPROVER_FORBIDDEN' });
    await rewrite(0, true).expect(409);
    await rewrite(1, null).expect(200);
    await expect(actor()).resolves.toMatchObject({ userId: 21 });
    supervisorRequired = true;
    try { await expect(actor()).rejects.toMatchObject({ code: 'ORDER_SUPERVISOR_REQUIRED' }); }
    finally { supervisorRequired = false; }
    await change('delete', '/api/session', approverCookie).expect(204);
    await expect(actor()).rejects.toMatchObject({ code: 'WEB_SESSION_REQUIRED' });
    const fresh = await login('comprueba');
    approver.active = false;
    try { await expect(access.orderActor(cookieToken(fresh))).rejects.toMatchObject({ code: 'WEB_SESSION_REQUIRED' }); }
    finally { approver.active = true; }
    await expect(access.orderActor(cookieToken(fresh))).rejects.toMatchObject({ code: 'WEB_SESSION_REQUIRED' });
  });

  it('gestiona altas web, edita la cuenta y revoca sesiones por baja o restablecimiento', async () => {
    const profile = { identification: 'personal-web', name: 'Cuenta de prueba', group: 41, active: true, administrator: false };
    const created = (await change('post', route, adminCookie).send(profile).expect(201)).body.data;
    expect(created).toMatchObject({ revision: 1, legacyId: null, configured: false, group: 41 });
    const detail = await request(app).get(`${route}/${created.id}`).set('Cookie', adminCookie).expect(200);
    expect(detail.body.data).toMatchObject({ legacyDetails: null, activationExpiresAt: null });
    await change('post', route, adminCookie).send({ ...profile, identification: 'ADMIN' }).expect(409);
    const path = `${route}/${created.id}`;
    const activate = async (revision: number) => {
      const activation = await change('post', `${path}/activation`, adminCookie).send({ revision }).expect(200);
      await change('post', '/api/session/activation').send({ token: activation.body.data.token, password }).expect(204);
    };
    await activate(1);
    const accountCookie = await login(profile.identification);
    const hash = (await db.query<{ password_hash: string }>('SELECT password_hash FROM tuvansa.web_users WHERE id=$1', [created.id])).rows[0]?.password_hash;
    expect(hash).toMatch(/^scrypt:[0-9a-f]{32}:[0-9a-f]{128}$/);
    expect(hash).not.toBe(await hashPassword(password));
    await change('patch', `${groups}/41`, adminCookie).send({ revision: 0, changes: [{ key: 'MPED5', allowed: true }] }).expect(200);
    await expect(access.orderActor(cookieToken(accountCookie))).resolves.toMatchObject({ webUserId: created.id, userName: profile.name });
    await activate(3);
    await expect(access.orderActor(cookieToken(accountCookie))).rejects.toMatchObject({ code: 'WEB_SESSION_REQUIRED' });
    const afterReset = await login(profile.identification);
    await change('patch', path, adminCookie).send({ ...profile, active: false, revision: 5 }).expect(200);
    await expect(access.orderActor(cookieToken(afterReset))).rejects.toMatchObject({ code: 'WEB_SESSION_REQUIRED' });
    await change('patch', path, adminCookie).send({ ...profile, revision: 5 }).expect(409);
  });

  it('conserva el último administrador, bloquea supervisor y detecta escrituras simultáneas', async () => {
    await change('patch', `${route}/g-1`, adminCookie).send({
      revision: 3, identification: 'administrador-web', name: admin.name, group: 0, active: false, administrator: true,
    }).expect(409).expect(({ body }) => expect(body.error.code).toBe('WEB_LAST_ADMIN'));
    const patch = (key: string) => change('patch', `${groups}/40`, adminCookie).send({ revision: 0, changes: [{ key, allowed: true }] });
    await patch('SUP').expect(400);
    const results = await Promise.all([patch('MPED5'), patch('INICIO13')]);
    expect(results.map(result => result.status).sort()).toEqual([200, 409]);
    const result = await change('patch', `${groups}/0`, adminCookie).send({ revision: 1, changes: [{ key: 'INICIO13', allowed: null }] }).expect(409);
    expect(result.body.error.code).toBe('WEB_LAST_ADMIN');
    expect((await db.query('SELECT 1 FROM tuvansa.schema_migrations WHERE id=\'002_web_users\'')).rows).toHaveLength(1);
    expect((await db.query('SELECT 1 FROM tuvansa.web_access_changes')).rows.length).toBeGreaterThan(10);
  });
});
