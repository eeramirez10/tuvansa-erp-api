import type { RowDataPacket } from 'mysql2';
import { createLegacyDbConnection } from './legacy-db-connection.js';

const connection = await createLegacyDbConnection();

try {
  const [tables] = await connection.query<RowDataPacket[]>(`
    SELECT TABLE_NAME AS tableName
      FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE()
       AND (
         TABLE_NAME LIKE '%BAN%'
         OR TABLE_NAME LIKE '%CTA%'
         OR TABLE_NAME LIKE '%CHEQ%'
         OR TABLE_NAME LIKE '%DEPO%'
         OR TABLE_NAME LIKE '%POL%'
         OR TABLE_NAME IN ('FAG', 'FALMCAT', 'FCCBENC')
       )
     ORDER BY TABLE_NAME
  `);
  console.table(tables);

  const names = tables.map((row) => String(row.tableName));
  if (names.length === 0) process.exit(0);

  const placeholders = names.map(() => '?').join(', ');
  const [columns] = await connection.query<RowDataPacket[]>(`
    SELECT TABLE_NAME AS tableName, ORDINAL_POSITION AS position,
           COLUMN_NAME AS columnName, COLUMN_TYPE AS columnType
      FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME IN (${placeholders})
     ORDER BY TABLE_NAME, ORDINAL_POSITION
  `, names);
  console.table(columns);

  const [relatedTables] = await connection.query<RowDataPacket[]>(`
    SELECT DISTINCT TABLE_NAME AS tableName
      FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND COLUMN_NAME IN ('BSEQ', 'BCOD', 'BNUM', 'BNOM', 'BSALDO', 'BSALDOANT')
     ORDER BY TABLE_NAME
  `);
  console.table(relatedTables);

  const relatedNames = relatedTables.map((row) => String(row.tableName));
  if (relatedNames.length > 0) {
    const relatedPlaceholders = relatedNames.map(() => '?').join(', ');
    const [relatedColumns] = await connection.query<RowDataPacket[]>(`
      SELECT TABLE_NAME AS tableName, ORDINAL_POSITION AS position,
             COLUMN_NAME AS columnName, COLUMN_TYPE AS columnType
        FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME IN (${relatedPlaceholders})
       ORDER BY TABLE_NAME, ORDINAL_POSITION
    `, relatedNames);
    console.table(relatedColumns);
  }

  const [accounts] = await connection.query<RowDataPacket[]>(`
    SELECT BSEQ AS id, BCOD AS code, BCTA AS accountNumber,
           BNOMBRE AS name, BTIPO AS type, BMONEDA AS currencyId,
           BSALDOR1 AS currentBalance, BSALDOB1 AS bankBalance
      FROM fbenc
     WHERE BGERENTE <> 'T'
     ORDER BY BCOD
     LIMIT 30
  `);
  console.table(accounts);

  const [bankAccounts] = await connection.query<RowDataPacket[]>(`
    SELECT BSEQ AS id, BCOD AS code, BCTA AS accountNumber,
           BNOMBRE AS name, BTIPO AS type, BMONEDA AS currencyId,
           BSALDOR1 AS currentBalance, BSALDOB1 AS bankBalance
      FROM fbenc
     WHERE BGERENTE <> 'T' AND BTIPO = 0 AND BCTA <> ''
     ORDER BY BCOD
     LIMIT 20
  `);
  console.table(bankAccounts);

  const [costCenterLedger] = await connection.query<RowDataPacket[]>(`
    SELECT *
      FROM fccbenc
     WHERE BCCKEY = '011  1102100001'
     LIMIT 1
  `);
  console.log('Mayor C.C. capturado para 1102100001');
  console.dir(costCenterLedger, { depth: null });

  const [costCenterLedgerKeyColumns] = await connection.query<RowDataPacket[]>(`
    SELECT ORDINAL_POSITION AS position, COLUMN_NAME AS columnName,
           COLUMN_TYPE AS columnType
      FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'fccbenc'
       AND ORDINAL_POSITION <= 20
     ORDER BY ORDINAL_POSITION
  `);
  console.log('Columnas clave FCCBENC');
  console.table(costCenterLedgerKeyColumns);
} finally {
  await connection.end();
}
