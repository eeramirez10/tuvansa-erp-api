import { migrateProductClassification } from '../src/modules/inventories/products/infrastructure/datasources/postgres-product-classification-data-source.js';
import { closePostgresPool, connectPostgres } from '../src/shared/infrastructure/database/postgres-pool.js';

try {
  const client = await connectPostgres();
  try {
    await migrateProductClassification(client);
    console.log('Migración de clasificación de inventario verificada.');
  } finally {
    client.release();
  }
} catch {
  console.error('No fue posible instalar la migración de clasificación en PostgreSQL.');
  process.exitCode = 1;
} finally {
  await closePostgresPool();
}
