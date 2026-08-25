import type { RowDataPacket } from 'mysql2';
import { createLegacyDbConnection } from './legacy-db-connection.js';

const connection = await createLegacyDbConnection();

const query = async (label: string, sql: string): Promise<void> => {
  try {
    const [rows] = await connection.query<RowDataPacket[]>(sql);
    console.log(label);
    console.table(rows);
  } catch (error) {
    console.log(label, error instanceof Error ? error.message : String(error));
  }
};

try {
  await query('Servidor conectado:', `
    SELECT
      @@hostname AS host,
      @@port AS port,
      DATABASE() AS databaseName,
      CURRENT_USER() AS authenticatedUser,
      CONNECTION_ID() AS connectionId,
      VERSION() AS version
  `);
  await query('Permisos del usuario:', 'SHOW GRANTS FOR CURRENT_USER');
  await query('Estado del registro general:', `
    SELECT
      @@global.general_log AS generalLogEnabled,
      @@global.log_output AS logOutput,
      @@global.general_log_file AS generalLogFile
  `);
  await query('Consumidores de sentencias:', `
    SELECT NAME, ENABLED
    FROM performance_schema.setup_consumers
    WHERE NAME LIKE 'events_statements%'
    ORDER BY NAME
  `);
  await query('Instrumentos SQL:', `
    SELECT NAME, ENABLED, TIMED
    FROM performance_schema.setup_instruments
    WHERE NAME LIKE 'statement/sql/%'
      AND ENABLED = 'YES'
    ORDER BY NAME
    LIMIT 20
  `);
  await query('Conexiones visibles:', `
    SELECT ID, USER, HOST, DB, COMMAND, TIME, STATE
    FROM information_schema.PROCESSLIST
    ORDER BY ID
  `);
  await query('Ultimas sentencias conservadas:', `
    SELECT
      THREAD_ID,
      EVENT_ID,
      CURRENT_SCHEMA,
      ROWS_EXAMINED,
      ROWS_SENT,
      LEFT(SQL_TEXT, 500) AS SQL_TEXT
    FROM performance_schema.events_statements_history_long
    WHERE SQL_TEXT IS NOT NULL
    ORDER BY TIMER_END DESC
    LIMIT 20
  `);
} finally {
  await connection.end();
}
