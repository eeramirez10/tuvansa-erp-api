import type { Connection, RowDataPacket } from 'mysql2/promise';
import { createLegacyDbConnection } from './legacy-db-connection.js';

interface ProcessRow extends RowDataPacket {
  ID: number;
  DB: string | null;
  INFO: string;
}

const watchers = Number(process.env.CAPTURE_WATCHERS ?? 4);
const durationMilliseconds = Number(process.env.CAPTURE_DURATION_MS ?? 15_000);
const connections: Connection[] = [];
const captured = new Map<string, { connectionId: number; database: string | null; sql: string }>();

try {
  connections.push(...await Promise.all(
    Array.from({ length: watchers }, () => createLegacyDbConnection()),
  ));

  console.log('READY');
  const finishAt = Date.now() + durationMilliseconds;

  while (Date.now() < finishAt) {
    const batches = await Promise.all(connections.map(async (connection) => {
      const [rows] = await connection.query<ProcessRow[]>(`
        SELECT ID, DB, INFO
        FROM information_schema.PROCESSLIST
        WHERE USER = 'consultas'
          AND HOST LIKE 'localhost:%'
          AND COMMAND <> 'Sleep'
          AND INFO IS NOT NULL
      `);
      return rows;
    }));

    for (const row of batches.flat()) {
      const normalizedSql = row.INFO.replaceAll(/\s+/g, ' ').trim();

      if (normalizedSql.includes('information_schema.PROCESSLIST')) {
        continue;
      }

      captured.set(`${row.ID}:${normalizedSql}`, {
        connectionId: row.ID,
        database: row.DB,
        sql: normalizedSql,
      });
    }

    await new Promise((resolve) => setTimeout(resolve, 1));
  }

  console.log(JSON.stringify([...captured.values()], null, 2));
} finally {
  await Promise.all(connections.map((connection) => connection.end()));
}
