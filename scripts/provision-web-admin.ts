import { env } from '../src/config/env.js';
import { webAccess } from '../src/modules/general-data/users/users-module.js';
import { webIdentification } from '../src/modules/general-data/users/presentation/web-access-router.js';
import { closePostgresPool } from '../src/shared/infrastructure/database/postgres-pool.js';
import { legacyMysqlPool } from '../src/shared/infrastructure/database/legacy-mysql-pool.js';
import { ApplicationError } from '../src/shared/domain/errors/application-error.js';

try {
  const [command, id, identification] = process.argv.slice(2);
  if (!id || !['create', 'reset'].includes(command) || (command === 'create' && !/^[1-9]\d{0,9}$/.test(id))) {
    throw new ApplicationError('Uso: pnpm users:admin create <USRSEQ> [identificación] | reset <ID web>', 'WEB_ADMIN_USAGE', 400);
  }
  const login = identification === undefined ? undefined : webIdentification.parse(identification);
  const { token } = command === 'create' ? await webAccess.bootstrapAdministrator(Number(id), login) : await webAccess.recoverAdministrator(id);
  const route = `/activar-cuenta#${token}`;
  console.log(env.WEB_SESSION_ORIGIN ? new URL(route, env.WEB_SESSION_ORIGIN).toString() : route);
} catch (error) {
  console.error(error instanceof ApplicationError ? error.message : 'No fue posible aprovisionar el administrador. Comprueba los argumentos y la configuración.');
  process.exitCode = 1;
} finally {
  await Promise.all([closePostgresPool(), legacyMysqlPool.end()]);
}
