import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import { legacyMysqlPool } from '../../../../../shared/infrastructure/database/legacy-mysql-pool.js';
import type { ProductUnit } from './product-catalog-record.js';
import { legacyProductRemovalRelation, productSource, selectProductFields, toProduct, type ProductRow } from './legacy-mysql-products-data-source.js';
import type { LegacyProductSnapshot } from './postgres-product-catalog-snapshot.js';

const tables = ['finv', 'funidad', 'fbenc', 'fens', 'faxinv', 'fplin', 'fvanu2', 'fcanu2'];
const chunkSize = 500;

interface TableRow extends RowDataPacket { tableName: string; engine: string | null }
interface UnitRow extends RowDataPacket {
  id: ProductUnit['id'];
  code: string | null;
  description: string | null;
  usesColorAndSize: number | null;
}
interface AccountRow extends RowDataPacket { code: string }
type TotalsRow = RowDataPacket & LegacyProductSnapshot['totals'];
interface CatalogRow extends ProductRow { deletionRelation: string | null }

async function* productBatches(connection: PoolConnection) {
  let previousId = 0;
  while (true) {
    const [rows] = await connection.execute<CatalogRow[]>(
      `SELECT ${selectProductFields},${legacyProductRemovalRelation} AS deletionRelation
       ${productSource}
       WHERE FINV.ISEQ > ? ORDER BY FINV.ISEQ LIMIT ?`,
      [previousId, chunkSize],
    );
    const finalRow = rows.at(-1);
    if (!finalRow) return;
    yield rows.map((row) => ({ document: toProduct(row).toPrimitives(), deletionRelation: row.deletionRelation }));
    previousId = finalRow.id;
  }
}

// Adaptadas. Todas las lecturas necesitan pertenecer a la misma copia consistente.
export const withLegacyProductSnapshot = async <T>(
  operation: (snapshot: LegacyProductSnapshot) => Promise<T>,
): Promise<T> => {
  const connection = await legacyMysqlPool.getConnection();
  try {
    const [storage] = await connection.execute<TableRow[]>(
      `SELECT LOWER(TABLE_NAME) AS tableName, ENGINE AS engine FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = DATABASE() AND LOWER(TABLE_NAME) IN (${tables.map(() => '?').join(',')})`,
      tables,
    );
    for (const name of tables) {
      if (!storage.some((table) => table.tableName === name && table.engine === 'InnoDB')) {
        throw new Error(`La tabla ${name} debe existir en una copia InnoDB para tomar una lectura consistente`);
      }
    }
    await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    try {
      await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ER_PARSE_ERROR') throw error;
      // Las versiones antiguas de MySQL admiten la copia consistente sin el modificador READ ONLY.
      await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT');
    }
    const [totalsRows] = await connection.query<TotalsRow[]>(
      `SELECT COUNT(*) AS productCount,
        CAST(COALESCE(SUM(CAST(ISTKACT AS DECIMAL(30,6))), 0) AS CHAR) AS currentStock,
        CAST(COALESCE(SUM(CAST(ISTKANT AS DECIMAL(30,6))), 0) AS CHAR) AS previousStock,
        CAST(COALESCE(SUM(CAST(ISTKPZS AS DECIMAL(30,6))), 0) AS CHAR) AS pieceStock
      FROM finv`,
    );
    const totals = totalsRows[0]!;
    const [units] = await connection.query<UnitRow[]>(
      `SELECT USEQ AS id, UCOD AS code, UDESCR AS description, UTIPO <> 0 AS usesColorAndSize FROM funidad`,
    );
    const [accounts] = await connection.query<AccountRow[]>('SELECT BCOD AS code FROM fbenc WHERE BCOD IS NOT NULL');
    return await operation({
      totals,
      units: units.map((unit) => ({
        id: unit.id,
        code: unit.code ?? '',
        description: unit.description ?? '',
        usesColorAndSize: Boolean(unit.usesColorAndSize),
      })),
      accounts: accounts.map(({ code }) => code),
      products: productBatches(connection),
    });
  } finally {
    try { await connection.rollback(); } finally { connection.release(); }
  }
};
