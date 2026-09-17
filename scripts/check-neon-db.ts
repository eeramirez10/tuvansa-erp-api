import { PostgresOrderOverlayDataSource } from '../src/modules/sales/orders/infrastructure/datasources/postgres-order-overlay-data-source.js';
import { closePostgresPool, connectPostgres } from '../src/shared/infrastructure/database/postgres-pool.js';
import { ApplicationError } from '../src/shared/domain/errors/application-error.js';

try {
  await new PostgresOrderOverlayDataSource().initialize();
  const client = await connectPostgres();
  try {
    const version = (await client.query<{ version: string }>("SELECT current_setting('server_version') AS version")).rows[0]?.version;
    const objects = (await client.query<{ orders: string | null; changes: string | null; stock: string | null }>(
      "SELECT to_regclass('tuvansa.orders')::text AS orders, to_regclass('tuvansa.order_changes')::text AS changes, to_regclass('tuvansa.order_stock_deltas')::text AS stock",
    )).rows[0];
    const migrations = (await client.query<{ id: string }>(
      'SELECT id FROM tuvansa.schema_migrations ORDER BY id',
    )).rows.map((row) => row.id);
    if (!objects?.orders || !objects.changes || !objects.stock || !migrations.includes('001_orders_overlay')) {
      throw new ApplicationError('Faltan tablas o migraciones de pedidos en Neon.', 'POSTGRES_SCHEMA_INCOMPLETE', 503);
    }
    console.log(`PostgreSQL conectado (versión ${version}). Esquema tuvansa y migración 001_orders_overlay verificados.`);
    console.log('Tablas: tuvansa.orders, tuvansa.order_changes, tuvansa.order_stock_deltas. No se modificó MySQL.');
  } finally { client.release(); }
} catch (error) {
  console.error(error instanceof ApplicationError ? error.message : 'No fue posible verificar Neon.');
  process.exitCode=1;
} finally { await closePostgresPool(); }
