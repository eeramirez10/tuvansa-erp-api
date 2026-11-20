import { migrateProductCatalogEdit } from '../src/modules/inventories/products/infrastructure/datasources/postgres-product-catalog-edit-data-source.js';
import { closePostgresPool, connectPostgres } from '../src/shared/infrastructure/database/postgres-pool.js';

try {
  const client = await connectPostgres();
  try {
    await migrateProductCatalogEdit(client);
    console.log('Migración de edición del catálogo verificada.');
  } finally {
    client.release();
  }
} catch {
  console.error('No fue posible instalar la migración del catálogo en PostgreSQL.');
  process.exitCode = 1;
} finally {
  await closePostgresPool();
}
