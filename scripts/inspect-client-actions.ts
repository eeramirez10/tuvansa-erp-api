import type { RowDataPacket } from 'mysql2';
import { createLegacyDbConnection } from './legacy-db-connection.js';

const connection = await createLegacyDbConnection();

try {
  const [clientRows] = await connection.query<RowDataPacket[]>(`
    SELECT * FROM fcli WHERE CLISEQ = 15331
  `);
  const clientRow = clientRows[0] ?? {};
  const client = Object.fromEntries(Object.entries(clientRow).filter(([column]) =>
    ['CLISEQ', 'CLICOD', 'CLINOM', 'CLIBAJA', 'CLIEVENTOS'].includes(column)
    || column.startsWith('CLIPAR')));
  const [clientColumnRows] = await connection.query<RowDataPacket[]>(`
    SELECT COLUMN_NAME, COLUMN_TYPE
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'fcli'
    ORDER BY ORDINAL_POSITION
  `);
  const clientColumnTypes = new Map(clientColumnRows.map((column) => [
    column.COLUMN_NAME as string,
    column.COLUMN_TYPE as string,
  ]));
  const populatedClientFields = Object.entries(clientRow)
    .filter(([, value]) => value !== '' && value !== 0 && value !== '0.00' && value !== null)
    .map(([column, value]) => ({
      column,
      type: clientColumnTypes.get(column),
      value,
    }));
  const [classificationConfig] = await connection.query<RowDataPacket[]>(`
    SELECT * FROM fyg WHERE YGKEY = 'ABITITPAR1'
  `);
  const [classifications] = await connection.query<RowDataPacket[]>(`
    SELECT AGSEQ, AGTNUM, AGDESCR, AGNUM, AGT, AGTIPO
    FROM fag
    WHERE AGTNUM IN ('1202', '211', '302')
    ORDER BY AGSEQ
  `);
  const [possibleMediaColumns] = await connection.query<RowDataPacket[]>(`
    SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND (
        LOWER(COLUMN_NAME) LIKE '%foto%'
        OR LOWER(COLUMN_NAME) LIKE '%image%'
        OR LOWER(COLUMN_NAME) LIKE '%imagen%'
        OR LOWER(COLUMN_NAME) LIKE '%archivo%'
      )
    ORDER BY TABLE_NAME, ORDINAL_POSITION
  `);
  const [contactColumns] = await connection.query<RowDataPacket[]>('SHOW COLUMNS FROM fcontactos');
  const [eventColumns] = await connection.query<RowDataPacket[]>('SHOW COLUMNS FROM feventos');
  const [sendToConfig] = await connection.query<RowDataPacket[]>(`
    SELECT * FROM fyg WHERE YGKEY = 'WIN-POS-ECLI2#1'
  `);
  const [photoConfig] = await connection.query<RowDataPacket[]>(`
    SELECT * FROM fyg WHERE YGKEY = 'WIN-POS-ECLI#36'
  `);

  console.dir({
    client,
    populatedClientFields,
    classificationConfig,
    classifications,
    possibleMediaColumns,
    contactColumns: contactColumns.map((column) => ({
      name: column.Field,
      type: column.Type,
    })),
    eventColumns: eventColumns.map((column) => ({
      name: column.Field,
      type: column.Type,
    })),
    sendToConfig,
    photoConfig,
  }, { depth: null });
} finally {
  await connection.end();
}
