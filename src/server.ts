import { createApp } from './app.js';
import { env } from './config/env.js';
import { legacyMysqlPool } from './shared/infrastructure/database/legacy-mysql-pool.js';

const app = createApp();

const server = app.listen(env.PORT, env.HOST, () => {
  console.log(`Tuvansa ERP API escuchando en http://${env.HOST}:${env.PORT}`);
});

let isShuttingDown = false;

const finishShutdown = async (
  forceShutdown: NodeJS.Timeout,
  serverError?: Error,
): Promise<void> => {
  let exitCode = serverError === undefined ? 0 : 1;

  if (serverError !== undefined) console.error('Error cerrando el servidor HTTP', serverError);

  try {
    await legacyMysqlPool.end();
  } catch (databaseError) {
    exitCode = 1;
    console.error('Error cerrando el pool MySQL', databaseError);
  }

  clearTimeout(forceShutdown);
  process.exit(exitCode);
};

const shutdown = (signal: NodeJS.Signals): void => {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(`Señal ${signal} recibida; cerrando la API`);

  const forceShutdown = setTimeout(() => {
    console.error('El cierre ordenado excedió 15 segundos');
    process.exit(1);
  }, 15_000);
  forceShutdown.unref();

  server.close((error) => {
    void finishShutdown(forceShutdown, error);
  });
};

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
