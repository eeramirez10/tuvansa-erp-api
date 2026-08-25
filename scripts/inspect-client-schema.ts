import type { RowDataPacket } from 'mysql2';
import { createLegacyDbConnection } from './legacy-db-connection.js';

interface TableRow extends RowDataPacket {
  TABLE_NAME: string;
  TABLE_TYPE: string;
}

interface ColumnRow extends RowDataPacket {
  TABLE_NAME: string;
  ORDINAL_POSITION: number;
  COLUMN_NAME: string;
  COLUMN_TYPE: string;
  IS_NULLABLE: 'YES' | 'NO';
  COLUMN_KEY: string;
}

interface ClientCountRow extends RowDataPacket {
  totalClients: number;
  uniqueCodes: number;
  activeBySentinelDate: number;
}

const connection = await createLegacyDbConnection();

try {
  const [tables] = await connection.execute<TableRow[]>(`
    SELECT TABLE_NAME, TABLE_TYPE
    FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = DATABASE()
      AND (LOWER(TABLE_NAME) LIKE '%cli%' OR LOWER(TABLE_NAME) LIKE '%cxc%')
    ORDER BY TABLE_NAME
  `);

  const [columns] = await connection.execute<ColumnRow[]>(`
    SELECT
      TABLE_NAME,
      ORDINAL_POSITION,
      COLUMN_NAME,
      COLUMN_TYPE,
      IS_NULLABLE,
      COLUMN_KEY
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND LOWER(TABLE_NAME) IN ('fcli', 'faxcli')
    ORDER BY TABLE_NAME, ORDINAL_POSITION
  `);

  const [clientCounts] = await connection.execute<ClientCountRow[]>(`
    SELECT
      COUNT(*) AS totalClients,
      COUNT(DISTINCT CLICOD) AS uniqueCodes,
      SUM(CLIBAJA = '1900-12-31') AS activeBySentinelDate
    FROM fcli
  `);

  console.log('Tablas relacionadas:');
  console.table(tables);
  console.log('Columnas del catalogo:');
  console.table(columns);
  console.log('Totales del catalogo:');
  console.table(clientCounts);
} finally {
  await connection.end();
}
