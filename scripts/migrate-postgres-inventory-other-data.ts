import { migrateProductOtherData } from '../src/modules/inventories/products/infrastructure/datasources/postgres-product-other-data-source.js';
import { closePostgresPool, connectPostgres } from '../src/shared/infrastructure/database/postgres-pool.js';

try {
  const client = await connectPostgres();
  try {
    await migrateProductOtherData(client);
    console.log('Migración de Otros de inventario verificada.');
  } finally {
    client.release();
  }
} catch {
  console.error('No fue posible instalar la migración de Otros en PostgreSQL.');
  process.exitCode = 1;
} finally {
  await closePostgresPool();
}
