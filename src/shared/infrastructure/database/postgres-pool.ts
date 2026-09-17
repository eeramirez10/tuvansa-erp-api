import pg from 'pg';
import { env } from '../../../config/env.js';
import { ApplicationError } from '../../domain/errors/application-error.js';

export interface PostgresClient {
  query<T extends object = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: T[] }>;
  release(): void;
}
export type PostgresConnectionFactory = () => Promise<PostgresClient>;
let pool: pg.Pool | undefined;

export const postgresConfigured = () => env.NEON_DATABASE_URL !== '';
export const postgresUnavailable = () => new ApplicationError(
  'Configura NEON_DATABASE_URL para habilitar las escrituras en PostgreSQL.', 'POSTGRES_NOT_CONFIGURED', 503);

export const connectPostgres: PostgresConnectionFactory = async () => {
  if (!postgresConfigured()) throw postgresUnavailable();
  if (!pool) {
    let url: URL;
    try { url = new URL(env.NEON_DATABASE_URL); }
    catch { throw new ApplicationError('NEON_DATABASE_URL no es una URL PostgreSQL válida.', 'POSTGRES_CONFIG_INVALID', 503); }
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || url.pathname.length < 2) {
      throw new ApplicationError('NEON_DATABASE_URL debe usar postgres:// o postgresql://.', 'POSTGRES_CONFIG_INVALID', 503);
    }
    // Preserve the current strict TLS behavior when pg adopts libpq semantics for these aliases.
    if (['prefer', 'require', 'verify-ca'].includes(url.searchParams.get('sslmode') ?? '')) {
      url.searchParams.set('sslmode', 'verify-full');
    }
    // Keep the URL private; only its in-memory TLS mode is normalized.
    pool = new pg.Pool({ connectionString: url.toString(), max: 5, connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 30_000, application_name: 'tuvansa-erp-api' });
    pool.on('error', () => console.error('PostgreSQL: conexión inactiva interrumpida.'));
  }
  const client = await pool.connect();
  return { query: (sql, values) => client.query(sql, values), release: () => client.release() };
};

export async function closePostgresPool(): Promise<void> {
  const current = pool; pool = undefined;
  await current?.end();
}
