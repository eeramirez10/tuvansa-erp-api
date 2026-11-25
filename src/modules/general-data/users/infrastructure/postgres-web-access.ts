import { randomUUID } from 'node:crypto';
import { ApplicationError } from '../../../../shared/domain/errors/application-error.js';
import { connectPostgres, type PostgresClient, type PostgresConnectionFactory } from '../../../../shared/infrastructure/database/postgres-pool.js';
import { migratePostgres, webAccessMigrations } from '../../../../shared/infrastructure/datasources/postgres-schema.js';
import {
  accessGroups, generalDataPermission, salesOrderPermission, userCatalogPermission, webIdentificationPattern,
  type DirectoryUser, type LegacyUserDirectory, type NativeUser, type PermissionChange, type UserProfile, type WebIdentity,
} from '../domain/user-directory.js';
import { hashPassword, newToken, tokenDigest, verifyPassword } from './web-credentials.js';

const requiredCatalog = [generalDataPermission, userCatalogPermission];
const identification = (value: string) => value.trim().toLowerCase();
const legacyKey = (id: number) => `g-${id}`;
const stale = () => new ApplicationError('El registro cambió. Vuelve a consultarlo antes de guardar.', 'WEB_ACCESS_STALE', 409);
const invalidCredentials = () => new ApplicationError('Identificación o contraseña incorrecta.', 'WEB_LOGIN_INVALID', 401);
export const sessionRequired = () => new ApplicationError('Inicia sesión para continuar.', 'WEB_SESSION_REQUIRED', 401);
const catalogDenied = () => new ApplicationError('Tu usuario no tiene acceso al catálogo de Usuarios.', 'WEB_USERS_FORBIDDEN', 403);

type UserRow = {
  id: string; legacyId: number | null; identification: string; name: string | null; group: number | null;
  active: boolean; administrator: boolean; password: string | null; revision: number;
};
type GroupRow = { revision: number };
const userColumns = 'id, legacy_id AS "legacyId", identification, name, group_id AS "group", active, administrator, password_hash AS password, revision';

function directoryUser(row?: UserRow, native?: NativeUser): DirectoryUser {
  const legacyActive = native?.active ?? null;
  const active = row?.active ?? native?.active ?? false;
  return {
    id: row?.id ?? legacyKey(native!.legacyId),
    legacyId: native?.legacyId ?? row?.legacyId ?? null,
    legacyIdentification: native?.identification ?? null,
    identification: row?.identification ?? native?.identification ?? '',
    name: row?.name ?? native?.name ?? '',
    group: row?.group ?? native?.group ?? -1,
    shared: native?.shared ?? false,
    active, legacyActive, administrator: row?.administrator ?? false, revision: row?.revision ?? 0,
    configured: Boolean(row?.password), effectiveActive: active && (row?.legacyId ? legacyActive === true : legacyActive !== false),
  };
}

export class PostgresWebAccess {
  private initialization: Promise<void> | undefined;

  constructor(private readonly native: LegacyUserDirectory, private readonly connect: PostgresConnectionFactory = connectPostgres) {}

  private async useClient<T>(work: (client: PostgresClient) => Promise<T>): Promise<T> {
    const client = await this.connect();
    try { return await work(client); }
    finally { client.release(); }
  }

  private async connection<T>(work: (client: PostgresClient) => Promise<T>): Promise<T> {
    this.initialization ??= this.useClient(client => migratePostgres(client, webAccessMigrations)).catch(error => {
      this.initialization = undefined;
      throw error;
    });
    await this.initialization;
    return this.useClient(work);
  }

  private transaction<T>(work: (client: PostgresClient) => Promise<T>) {
    return this.connection(async client => {
      await client.query('BEGIN');
      try {
        const result = await work(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    });
  }

  private async getUser(client: PostgresClient, id: string, lock = false) {
    return (await client.query<UserRow>(`SELECT ${userColumns} FROM tuvansa.web_users WHERE id=$1 ${lock ? 'FOR UPDATE' : ''}`, [id])).rows[0];
  }

  private async identity(row?: UserRow): Promise<WebIdentity | null> {
    if (!row?.active || !row.password) return null;
    const user = directoryUser(row, row.legacyId ? await this.native.user(row.legacyId) : undefined);
    if (!user.effectiveActive || !accessGroups.includes(user.group)) return null;
    return { id: user.id, name: user.name, identification: user.identification, group: user.group,
      legacyId: user.legacyId, administrator: user.administrator };
  }

  private async permissions(client: PostgresClient, group: number, keys?: string[]) {
    const native = await this.native.permissions(group, keys);
    const { rows } = await client.query<{ key: string; allowed: boolean }>(
      'SELECT permission_key AS key, allowed FROM tuvansa.web_permission_overrides WHERE group_id=$1', [group]);
    const overrides = new Map(rows.map(row => [row.key, row.allowed]));
    return native.map(({ allowed: inherited, ...permission }) => {
      const override = overrides.get(permission.key) ?? null;
      return { ...permission, inherited, override, allowed: (override ?? inherited) && !permission.requiresSupervisor };
    });
  }

  private async capabilities(client: PostgresClient, user: WebIdentity) {
    const permissions = await this.permissions(client, user.group, [...requiredCatalog, salesOrderPermission]);
    const allowed = (key: string) => permissions.some(permission => permission.key === key && permission.allowed);
    const generalData = allowed(generalDataPermission);
    return { generalData, users: generalData && allowed(userCatalogPermission) && user.administrator,
      authorizeOrders: allowed(salesOrderPermission) };
  }

  async authenticate(token?: string) {
    if (!token) return null;
    return this.connection(async client => {
      const { rows } = await client.query<{ userId: string }>(`UPDATE tuvansa.web_sessions
        SET idle_until=least(now()+interval '30 minutes',expires_at)
        WHERE digest=$1 AND idle_until>now() AND expires_at>now()
        RETURNING user_id AS "userId"`, [tokenDigest(token)]);
      if (!rows[0]) return null;
      const user = await this.identity(await this.getUser(client, rows[0].userId));
      if (!user) await this.revoke(client, rows[0].userId);
      return user;
    });
  }

  session(user: WebIdentity) {
    return this.connection(async client => ({ user, capabilities: await this.capabilities(client, user) }));
  }

  async requireCatalog(token?: string) {
    const user = await this.authenticate(token);
    if (!user) throw sessionRequired();
    if (!(await this.session(user)).capabilities.users) throw catalogDenied();
    return user;
  }

  async orderActor(token?: string) {
    const user = await this.authenticate(token);
    if (!user) throw sessionRequired();
    const [permission] = await this.connection(client => this.permissions(client, user.group, [salesOrderPermission]));
    if (permission?.requiresSupervisor) throw new ApplicationError('Esta acción requiere validación adicional de un supervisor en Omnis.', 'ORDER_SUPERVISOR_REQUIRED', 403);
    if (!permission?.allowed) throw new ApplicationError('El usuario no tiene permiso para autorizar pedidos.', 'ORDER_APPROVER_FORBIDDEN', 403);
    return { webUserId: user.id, ...(user.legacyId ? { userId: user.legacyId } : {}), userName: user.name, userIdentification: user.identification };
  }

  private async consumeAttempt(client: PostgresClient, key: string, limit: number) {
    const window = Math.floor(Date.now() / (15 * 60_000));
    const bucket = tokenDigest(`${window}:${key}`);
    const { rows } = await client.query<{ attempts: number }>(`INSERT INTO tuvansa.web_login_attempts(bucket,attempts,expires_at)
      VALUES($1,1,now()+interval '15 minutes')
      ON CONFLICT(bucket) DO UPDATE SET attempts=least(tuvansa.web_login_attempts.attempts+1,100)
      RETURNING attempts`, [bucket]);
    if (!rows[0] || rows[0].attempts > limit) throw new ApplicationError('Demasiados intentos. Vuelve a intentar más tarde.', 'WEB_LOGIN_LIMIT', 429);
  }

  async login(code: string, password: string, address: string, previousToken?: string) {
    const login = identification(code);
    const row = await this.connection(async client => {
      await client.query('DELETE FROM tuvansa.web_login_attempts WHERE expires_at<=now()');
      await this.consumeAttempt(client, `ip:${address}`, 60);
      await this.consumeAttempt(client, `user:${login}`, 10);
      return (await client.query<UserRow>(`SELECT ${userColumns} FROM tuvansa.web_users WHERE lower(identification)=$1`, [login])).rows[0];
    });
    if (!(await verifyPassword(password, row?.password)) || !row) throw invalidCredentials();
    const result = await this.transaction(async client => {
      const current = await this.getUser(client, row.id, true);
      const user = current?.password === row.password ? await this.identity(current) : null;
      if (!user) throw invalidCredentials();
      const token = newToken();
      if (previousToken) await client.query('DELETE FROM tuvansa.web_sessions WHERE digest=$1', [tokenDigest(previousToken)]);
      await client.query('DELETE FROM tuvansa.web_sessions WHERE idle_until<=now()');
      await client.query(`INSERT INTO tuvansa.web_sessions(digest,user_id,idle_until,expires_at)
        VALUES($1,$2,now()+interval '30 minutes',now()+interval '8 hours')`, [tokenDigest(token), user.id]);
      return { token, session: { user, capabilities: await this.capabilities(client, user) } };
    });
    return result;
  }

  async logout(token?: string) {
    if (token) await this.connection(client => client.query('DELETE FROM tuvansa.web_sessions WHERE digest=$1', [tokenDigest(token)]));
  }

  async activate(token: string, password: string) {
    const digest = tokenDigest(token);
    const found = await this.connection(client => client.query(
      'SELECT 1 FROM tuvansa.web_activations WHERE digest=$1 AND expires_at>now()', [digest]));
    if (!found.rows.length) throw this.invalidActivation();
    const hash = await hashPassword(password);
    await this.transaction(async client => {
      await this.lockAccess(client);
      const { rows } = await client.query<{ id: string }>(`DELETE FROM tuvansa.web_activations WHERE digest=$1
        AND expires_at>now() RETURNING user_id AS id`, [digest]);
      const row = rows[0] ? await this.getUser(client, rows[0].id, true) : undefined;
      if (!row || !(await this.identity({ ...row, password: hash }))) throw this.invalidActivation();
      await client.query('UPDATE tuvansa.web_users SET password_hash=$2,revision=revision+1 WHERE id=$1', [row.id, hash]);
      await this.revoke(client, row.id);
      await this.audit(client, row.id, 'activate', row.id, {});
    });
  }

  private invalidActivation() {
    return new ApplicationError('El enlace de activación venció o ya se utilizó.', 'WEB_ACTIVATION_INVALID', 400);
  }

  private async directory(client: PostgresClient) {
    const native = await this.native.users();
    const { rows } = await client.query<UserRow>(`SELECT ${userColumns} FROM tuvansa.web_users`);
    const saved = new Map(rows.map(row => [row.id, row]));
    return [
      ...native.map(user => directoryUser(saved.get(legacyKey(user.legacyId)), user)),
      ...rows.filter(user => user.legacyId === null).map(user => directoryUser(user)),
    ];
  }

  listUsers() {
    return this.connection(client => this.directory(client));
  }

  private async lockAccess(client: PostgresClient) {
    await client.query('SELECT pg_advisory_xact_lock(715009)');
  }

  private async catalogWrite<T>(id: string, work: (client: PostgresClient) => Promise<T>) {
    return this.transaction(async client => {
      await this.lockAccess(client);
      const actor = await this.identity(await this.getUser(client, id));
      if (!actor || !(await this.capabilities(client, actor)).users) throw catalogDenied();
      return work(client);
    });
  }

  private async audit(client: PostgresClient, actor: string, action: string, subject: string, details: object) {
    await client.query('INSERT INTO tuvansa.web_access_changes(actor,action,subject,details) VALUES($1,$2,$3,$4::jsonb)',
      [actor, action, subject, JSON.stringify(details)]);
  }

  private async revoke(client: PostgresClient, id: string) {
    await client.query('DELETE FROM tuvansa.web_sessions WHERE user_id=$1', [id]);
  }

  private async retainAdministrator(client: PostgresClient) {
    const administrators = (await this.directory(client)).filter(user => user.effectiveActive && user.administrator && user.configured);
    for (const group of new Set(administrators.map(user => user.group).filter(group => accessGroups.includes(group)))) {
      const permissions = await this.permissions(client, group, requiredCatalog);
      if (requiredCatalog.every(key => permissions.some(permission => permission.key === key && permission.allowed))) return;
    }
    throw new ApplicationError('Debe quedar un administrador activo con acceso a Usuarios.', 'WEB_LAST_ADMIN', 409);
  }

  private async saveProfile(client: PostgresClient, id: string, profile: UserProfile, previous?: DirectoryUser) {
    const login = identification(profile.identification);
    if (login.length > 32 || !webIdentificationPattern.test(login)) {
      throw new ApplicationError('Elige una identificación web válida para esta cuenta.', 'WEB_IDENTIFICATION_INVALID', 400);
    }
    const directory = await this.directory(client);
    if (directory.some(user => user.id !== id && [user.identification, user.legacyIdentification].some(code => code && identification(code) === login))) {
      throw new ApplicationError('La identificación ya está en uso. Elige una identificación web distinta.', 'WEB_IDENTIFICATION_IN_USE', 409);
    }
    const native = previous?.legacyId ? await this.native.user(previous.legacyId) : undefined;
    const { rows } = await client.query<UserRow>(`INSERT INTO tuvansa.web_users(id,legacy_id,identification,name,group_id,active,administrator)
      VALUES($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT(id) DO UPDATE SET identification=excluded.identification,name=excluded.name,group_id=excluded.group_id,
        active=excluded.active,administrator=excluded.administrator,revision=tuvansa.web_users.revision+1
      RETURNING ${userColumns}`, [id, previous?.legacyId ?? null, login, profile.name === native?.name ? null : profile.name,
      profile.group === native?.group ? null : profile.group, profile.active, profile.administrator]);
    return directoryUser(rows[0], native);
  }

  createUser(actor: string, profile: UserProfile) {
    return this.catalogWrite(actor, async client => {
      const user = await this.saveProfile(client, randomUUID(), profile);
      await this.audit(client, actor, 'create-user', user.id, user);
      return user;
    });
  }

  private async selectedUser(client: PostgresClient, id: string, revision: number) {
    const row = await this.getUser(client, id, true);
    const legacyId = id.startsWith('g-') ? Number(id.slice(2)) : undefined;
    const native = legacyId ? await this.native.user(legacyId) : undefined;
    if ((legacyId && !native) || (!row && !native)) throw new ApplicationError('Usuario no encontrado.', 'WEB_USER_NOT_FOUND', 404);
    const user = directoryUser(row, native);
    if (revision !== user.revision) throw stale();
    return user;
  }

  updateUser(actor: string, id: string, revision: number, profile: UserProfile) {
    return this.catalogWrite(actor, async client => {
      const previous = await this.selectedUser(client, id, revision);
      const user = await this.saveProfile(client, id, profile, previous);
      if (!user.effectiveActive) {
        await this.revoke(client, id);
        await client.query('DELETE FROM tuvansa.web_activations WHERE user_id=$1', [id]);
      }
      await this.retainAdministrator(client);
      await this.audit(client, actor, 'update-user', id, { previous, user });
      return user;
    });
  }

  private async issueActivation(client: PostgresClient, actor: string, user: DirectoryUser) {
    const token = newToken();
    await client.query(`INSERT INTO tuvansa.web_activations(digest,user_id,expires_at) VALUES($1,$2,now()+interval '24 hours')
      ON CONFLICT(user_id) DO UPDATE SET digest=excluded.digest,expires_at=excluded.expires_at`, [tokenDigest(token), user.id]);
    await client.query('UPDATE tuvansa.web_users SET password_hash=NULL,revision=revision+1 WHERE id=$1', [user.id]);
    await this.revoke(client, user.id);
    await this.audit(client, actor, 'issue-activation', user.id, {});
    return { token, revision: user.revision + 1 };
  }

  activateUser(actor: string, id: string, revision: number) {
    return this.catalogWrite(actor, async client => {
      let user = await this.selectedUser(client, id, revision);
      if (!user.effectiveActive) throw new ApplicationError('Activa la ficha del usuario antes de emitir el enlace.', 'WEB_USER_INACTIVE', 409);
      if (!accessGroups.includes(user.group)) throw new ApplicationError('Asigna un grupo válido al usuario antes de emitir el enlace.', 'WEB_USER_GROUP_INVALID', 409);
      if (user.revision === 0) user = await this.saveProfile(client, id, user, user);
      return this.issueActivation(client, actor, user);
    });
  }

  private async groupRevision(client: PostgresClient, group: number) {
    const { rows } = await client.query<GroupRow>('SELECT revision FROM tuvansa.web_permission_groups WHERE group_id=$1', [group]);
    return rows[0]?.revision ?? 0;
  }

  getGroup(group: number) {
    return this.connection(async client => ({ revision: await this.groupRevision(client, group), items: await this.permissions(client, group) }));
  }

  private async writeGroup(client: PostgresClient, group: number, changes: PermissionChange[]) {
    await client.query(`INSERT INTO tuvansa.web_permission_groups(group_id,revision) VALUES($1,1)
      ON CONFLICT(group_id) DO UPDATE SET revision=tuvansa.web_permission_groups.revision+1`, [group]);
    for (const { key, allowed } of changes) {
      if (allowed === null) {
        await client.query('DELETE FROM tuvansa.web_permission_overrides WHERE group_id=$1 AND permission_key=$2', [group, key]);
      } else {
        await client.query(`INSERT INTO tuvansa.web_permission_overrides(group_id,permission_key,allowed) VALUES($1,$2,$3)
          ON CONFLICT(group_id,permission_key) DO UPDATE SET allowed=excluded.allowed`, [group, key, allowed]);
      }
    }
  }

  updateGroup(actor: string, group: number, revision: number, changes: PermissionChange[]) {
    return this.catalogWrite(actor, async client => {
      if (revision !== await this.groupRevision(client, group)) throw stale();
      const previous = await this.permissions(client, group, changes.map(change => change.key));
      if (changes.some(change => !previous.some(item => item.key === change.key && !item.requiresSupervisor))) {
        throw new ApplicationError('El permiso no es editable en el catálogo web.', 'WEB_PERMISSION_INVALID', 400);
      }
      await this.writeGroup(client, group, changes);
      await this.retainAdministrator(client);
      await this.audit(client, actor, 'update-permissions', String(group), { previous, changes });
      return { revision: revision + 1, items: await this.permissions(client, group) };
    });
  }

  recoverAdministrator(id: string) {
    return this.transaction(async client => {
      await this.lockAccess(client);
      const row = await this.getUser(client, id, true);
      const native = row?.legacyId ? await this.native.user(row.legacyId) : undefined;
      const user = row ? directoryUser(row, native) : null;
      if (!user?.administrator || !user.effectiveActive) throw catalogDenied();
      return this.issueActivation(client, 'console-recovery', user);
    });
  }

  bootstrapAdministrator(legacyId: number, login?: string) {
    return this.transaction(async client => {
      await this.lockAccess(client);
      if ((await client.query('SELECT 1 FROM tuvansa.web_users WHERE administrator LIMIT 1')).rows.length) {
        throw new ApplicationError('Ya existe un administrador web. Usa el catálogo para administrar las cuentas.', 'WEB_ADMIN_EXISTS', 409);
      }
      const native = await this.native.user(legacyId);
      if (!native?.active || !accessGroups.includes(native.group)) {
        throw new ApplicationError('Elige un usuario activo de German para México con un grupo válido.', 'WEB_BOOTSTRAP_USER', 400);
      }
      const permissions = await this.permissions(client, native.group, requiredCatalog);
      if (permissions.length !== requiredCatalog.length || permissions.some(item => item.requiresSupervisor)) {
        throw new ApplicationError('Los permisos de acceso de German no están disponibles para ese grupo.', 'WEB_BOOTSTRAP_PERMISSION', 409);
      }
      const changes = permissions.filter(item => !item.allowed).map(item => ({ key: item.key, allowed: true }));
      if (changes.length) {
        await this.writeGroup(client, native.group, changes);
        await this.audit(client, 'bootstrap', 'update-permissions', String(native.group), { changes });
      }
      const user = directoryUser(undefined, native);
      const administrator = await this.saveProfile(client, user.id, { ...user, administrator: true, identification: login ?? user.identification }, user);
      await this.audit(client, 'bootstrap', 'create-administrator', administrator.id, administrator);
      return this.issueActivation(client, 'bootstrap', administrator);
    });
  }
}
