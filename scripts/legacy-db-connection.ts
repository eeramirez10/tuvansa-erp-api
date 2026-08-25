import 'dotenv/config';
import mysql, { type ConnectionOptions } from 'mysql2/promise';

const requiredVariables = [
  'LEGACY_DB_HOST',
  'LEGACY_DB_USER',
  'LEGACY_DB_PASSWORD',
  'LEGACY_DB_NAME',
] as const;

for (const variable of requiredVariables) {
  if (process.env[variable] === undefined || process.env[variable] === '') {
    throw new Error(`Falta la variable ${variable}`);
  }
}

const options: ConnectionOptions = {
  host: process.env.LEGACY_DB_HOST,
  port: Number(process.env.LEGACY_DB_PORT ?? 3306),
  user: process.env.LEGACY_DB_USER,
  password: process.env.LEGACY_DB_PASSWORD,
  database: process.env.LEGACY_DB_NAME,
  connectTimeout: 10_000,
  multipleStatements: false,
  ...(process.env.LEGACY_DB_SSL === 'true' ? { ssl: {} } : {}),
};

export const createLegacyDbConnection = () => mysql.createConnection(options);
