import { closePostgresPool, connectPostgres } from '../src/shared/infrastructure/database/postgres-pool.js';
import { migratePostgresProductCatalog } from '../src/modules/inventories/products/infrastructure/datasources/postgres-product-catalog-schema.js';
import { stageProductCatalog } from '../src/modules/inventories/products/infrastructure/datasources/postgres-product-catalog-snapshot.js';

if (process.argv.slice(2).join(' ') !== '--stage') {
  console.error('Uso: pnpm exec tsx scripts/stage-postgres-product-catalog.ts --stage');
  process.exitCode = 1;
} else {
  try {
    const { legacyMysqlPool } = await import('../src/shared/infrastructure/database/legacy-mysql-pool.js');
    try {
      const { withLegacyProductSnapshot } = await import(
        '../src/modules/inventories/products/infrastructure/datasources/legacy-mysql-product-catalog-snapshot.js'
      );
      const client = await connectPostgres();
      try { await migratePostgresProductCatalog(client); } finally { client.release(); }
      const totals = await withLegacyProductSnapshot((snapshot) => stageProductCatalog(connectPostgres, snapshot));
      console.log(`Catálogo conciliado: ${totals.productCount} productos en PostgreSQL.`);
    } finally {
      await legacyMysqlPool.end();
    }
  } catch {
    console.error('No se pudo instalar o conciliar el catálogo PostgreSQL. Revisa el destino, los permisos y el origen InnoDB.');
    process.exitCode = 1;
  } finally {
    await closePostgresPool();
  }
}
