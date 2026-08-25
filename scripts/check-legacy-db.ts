import { createLegacyDbConnection } from './legacy-db-connection.js';

const connection = await createLegacyDbConnection();

try {
  const [rows] = await connection.query(
    'SELECT 1 AS connection_ok, DATABASE() AS active_database, VERSION() AS server_version',
  );
  console.log(rows);
} finally {
  await connection.end();
}
