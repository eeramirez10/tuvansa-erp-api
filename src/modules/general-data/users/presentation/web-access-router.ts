import { Router } from 'express';
import { z } from 'zod';
import { webIdentificationPattern } from '../domain/user-directory.js';
import { type PostgresWebAccess } from '../infrastructure/postgres-web-access.js';
import { tokenPattern } from '../infrastructure/web-credentials.js';
import { cookieName, noSessionCache, requireSessionOrigin, sessionCookie, sessionToken } from './web-session-http.js';

export const webIdentification = z.string().trim().min(1).max(32).regex(webIdentificationPattern);
const password = z.string().min(6, 'Usa al menos 6 caracteres').max(128);
const group = z.coerce.number().int().min(0).max(41);
const revision = z.number().int().nonnegative();
const userId = z.union([z.uuid(), z.string().regex(/^g-[1-9]\d{0,9}$/)
  .refine(value => Number(value.slice(2)) <= 2147483647)]);
const profile = z.strictObject({
  identification: webIdentification, name: z.string().trim().min(1).max(46),
  group: z.number().int().min(0).max(41), active: z.boolean(), administrator: z.boolean(),
});
const permissionChanges = z.array(z.strictObject({ key: z.string().trim().min(1).max(20), allowed: z.boolean().nullable() }))
  .min(1).max(2000).refine(changes => new Set(changes.map(change => change.key)).size === changes.length);

export function createWebSessionRouter(access: PostgresWebAccess) {
  const router = Router();
  router.use(noSessionCache);
  router.get('/', async (req, res) => {
    const user = await access.authenticate(sessionToken(req));
    res.json({ data: user ? await access.session(user) : null });
  });
  router.post('/', async (req, res) => {
    requireSessionOrigin(req);
    const credentials = z.strictObject({ identification: webIdentification, password: z.string().min(1).max(128) }).parse(req.body);
    const { token, session } = await access.login(credentials.identification, credentials.password, req.ip ?? '', sessionToken(req));
    res.cookie(cookieName, token, { ...sessionCookie, maxAge: 8 * 60 * 60 * 1000 });
    res.json({ data: session });
  });
  router.delete('/', async (req, res) => {
    requireSessionOrigin(req);
    await access.logout(sessionToken(req));
    res.clearCookie(cookieName, sessionCookie).status(204).end();
  });
  router.post('/activation', async (req, res) => {
    requireSessionOrigin(req);
    const input = z.strictObject({ token: z.string().regex(tokenPattern), password }).parse(req.body);
    await access.activate(input.token, input.password);
    res.status(204).end();
  });
  return router;
}

export function createUserDirectoryRouter(access: PostgresWebAccess) {
  const router = Router();
  router.use(noSessionCache, async (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') requireSessionOrigin(req);
    res.locals.actor = await access.requireCatalog(sessionToken(req));
    next();
  });
  router.get('/users', async (req, res) => {
    const query = z.object({
      search: z.string().trim().max(100).default(''), group: group.optional(),
      state: z.enum(['active', 'inactive', 'pending']).optional(),
      offset: z.coerce.number().int().nonnegative().default(0), limit: z.coerce.number().int().min(1).max(100).default(25),
      anchor: userId.optional(), direction: z.enum(['previous', 'next']).optional(),
    }).refine(query => (query.anchor === undefined) === (query.direction === undefined)).parse(req.query);
    const search = query.search.toLocaleLowerCase('es-MX');
    const users = (await access.listUsers()).filter(user =>
      (query.group === undefined || user.group === query.group) &&
      (!query.state || query.state === (!user.effectiveActive ? 'inactive' : user.configured ? 'active' : 'pending')) &&
      [user.identification, user.legacyIdentification, user.name].some(value => value?.toLocaleLowerCase('es-MX').includes(search)));
    users.sort((first, second) => first.identification.localeCompare(second.identification, 'es-MX') || first.id.localeCompare(second.id));
    if (query.anchor && query.direction) {
      const anchor = users.findIndex(user => user.id === query.anchor);
      const position = anchor + (query.direction === 'next' ? 1 : -1);
      const adjacent = anchor >= 0 ? users[position] : undefined;
      res.json({ data: { items: adjacent ? [adjacent] : [], total: users.length, position: adjacent ? position : null } });
      return;
    }
    res.json({ data: { items: users.slice(query.offset, query.offset + query.limit), total: users.length } });
  });
  router.post('/users', async (req, res) => {
    res.status(201).json({ data: await access.createUser(res.locals.actor.id, profile.parse(req.body)) });
  });
  router.get('/users/:userId', async (req, res) => {
    res.json({ data: await access.getUserDetail(userId.parse(req.params.userId)) });
  });
  router.patch('/users/:userId', async (req, res) => {
    const { revision: current, ...input } = profile.extend({ revision }).parse(req.body);
    res.json({ data: await access.updateUser(res.locals.actor.id, userId.parse(req.params.userId), current, input) });
  });
  router.post('/users/:userId/activation', async (req, res) => {
    const body = z.strictObject({ revision }).parse(req.body);
    res.json({ data: await access.activateUser(res.locals.actor.id, userId.parse(req.params.userId), body.revision) });
  });
  router.get('/permission-groups/:group', async (req, res) => {
    res.json({ data: await access.getGroup(group.parse(req.params.group)) });
  });
  router.patch('/permission-groups/:group', async (req, res) => {
    const body = z.strictObject({ revision, changes: permissionChanges }).parse(req.body);
    res.json({ data: await access.updateGroup(res.locals.actor.id, group.parse(req.params.group), body.revision, body.changes) });
  });
  return router;
}
