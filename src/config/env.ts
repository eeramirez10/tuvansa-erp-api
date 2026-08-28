import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().min(1).default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().default(3000),
  API_PREFIX: z.string().startsWith('/').default('/api'),
  CORS_ORIGINS: z
    .string()
    .min(1)
    .default('*')
    .transform((value) =>
      value === '*'
        ? '*'
        : value
            .split(',')
            .map((origin) => origin.trim())
            .filter((origin) => origin !== ''),
    ),
  TRUST_PROXY: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  LEGACY_DB_HOST: z.string().min(1).optional(),
  LEGACY_DB_PORT: z.coerce.number().int().positive().default(3306),
  LEGACY_DB_USER: z.string().min(1).optional(),
  LEGACY_DB_PASSWORD: z.string().optional(),
  LEGACY_DB_NAME: z.string().min(1).optional(),
  LEGACY_DB_SSL: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
});

export const env = envSchema.parse(process.env);
