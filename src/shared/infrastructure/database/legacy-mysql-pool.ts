import mysql from 'mysql2/promise';
import { env } from '../../../config/env.js';

const requireValue = (value: string | undefined, variable: string): string => {
  if (value === undefined || value === '') {
    throw new Error(`Falta configurar ${variable}`);
  }

  return value;
};

export const legacyMysqlPool = mysql.createPool({
  host: requireValue(env.LEGACY_DB_HOST, 'LEGACY_DB_HOST'),
  port: env.LEGACY_DB_PORT,
  user: requireValue(env.LEGACY_DB_USER, 'LEGACY_DB_USER'),
  password: requireValue(env.LEGACY_DB_PASSWORD, 'LEGACY_DB_PASSWORD'),
  database: requireValue(env.LEGACY_DB_NAME, 'LEGACY_DB_NAME'),
  ...(env.LEGACY_DB_SSL ? { ssl: {} } : {}),
  waitForConnections: true,
  connectionLimit: 10,
  maxIdle: 10,
  idleTimeout: 60_000,
  queueLimit: 0,
  enableKeepAlive: true,
  decimalNumbers: true,
  dateStrings: true,
  multipleStatements: false,
});
