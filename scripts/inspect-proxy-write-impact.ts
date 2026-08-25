import type { RowDataPacket } from 'mysql2';
import { createLegacyDbConnection } from './legacy-db-connection.js';

const connection = await createLegacyDbConnection();

try {
  const [engines] = await connection.query<RowDataPacket[]>(`
    SELECT TABLE_NAME AS tableName, ENGINE AS engine
    FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = 'tuvansa'
      AND TABLE_NAME IN ('fcia', 'fag', 'fcoment', 'fhelp', 'fnumeros', 'fsucursales', 'fses')
    ORDER BY TABLE_NAME
  `);

  const [companyRows] = await connection.query<RowDataPacket[]>(`
    SELECT CIASEQ AS companySequence, CIAKEY AS companyKey, CIANAME AS companyName
    FROM tuvansa.fcia
    WHERE CIASEQ = 134116 OR CIAKEY = 34
    ORDER BY CIASEQ
  `);

  const [sessionRows] = await connection.query<RowDataPacket[]>(`
    SELECT SESSEQ AS sessionSequence, SESID AS sessionId, SESREG AS registeredAt
    FROM tuvansa.fses
    WHERE SESID = 34
    ORDER BY SESSEQ DESC
    LIMIT 5
  `);

  console.log(JSON.stringify({ engines, companyRows, sessionRows }, null, 2));
} finally {
  await connection.end();
}
