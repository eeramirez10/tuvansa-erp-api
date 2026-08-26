import type { RowDataPacket } from 'mysql2';
import { createLegacyDbConnection } from './legacy-db-connection.js';

const connection = await createLegacyDbConnection();

try {
  const visibleColumns = [
    'ISEQ', 'ICOD', 'IDESCR', 'ITIPO', 'USEQ', 'IUM', 'IFAM', 'IFAM1', 'IFOTO',
    'ILISTA1', 'ILISTA2', 'ILISTA3', 'ILISTA4', 'ILISTA5', 'ILISTA6',
    'IMONEDA', 'IMONEDA1', 'IMONEDA2', 'IMONEDA3', 'IMONEDA4', 'IMONEDA5',
    'IMINIMO', 'IMAXIMO', 'ILOCALIZ', 'IEAN', 'IUPC', 'ICTA', 'ICTA3', 'ICTADEV',
    'IULTCPR', 'IULTVTA', 'IASIGNADO', 'ICONFIRMADO', 'IPEDCLI', 'IPEDCOTIZ',
    'IPEDPRV', 'IORDCOTIZ', 'ISTKACT', 'ISTKANT', 'ISTKACU', 'ICANACT', 'ICANTAN',
    'ICANTAC', 'ISTKPZS', 'IALTA', 'IBAJA', 'IVTA', 'IDIASSTK', 'IADVALOREM',
  ];
  const [columns] = await connection.query<RowDataPacket[]>(`
    SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_KEY, EXTRA
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'finv'
      AND COLUMN_NAME IN (${visibleColumns.map(() => '?').join(', ')})
    ORDER BY ORDINAL_POSITION
  `, visibleColumns);
  const [sample] = await connection.query<RowDataPacket[]>(`
    SELECT ${visibleColumns.join(', ')}
    FROM finv
    WHERE ICOD = '004212899'
    LIMIT 1
  `);
  const [units] = await connection.query<RowDataPacket[]>(`
    SELECT USEQ, UCOD, UDESCR, UTIPO
    FROM funidad
    WHERE USEQ = 1 OR UCOD = 'PZ'
    ORDER BY USEQ
    LIMIT 10
  `);

  console.log(JSON.stringify({ columns, sample, units }, null, 2));
} finally {
  await connection.end();
}
