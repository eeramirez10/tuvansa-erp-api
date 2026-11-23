import 'dotenv/config';
import { z } from 'zod';

const productPilots = z.string().default('')
  .transform((value) => value.trim() === '' ? [] : value.split(',').map((id) => id.trim()))
  .pipe(z.array(z.string().regex(/^[1-9]\d*$/).transform(Number).pipe(z.int().positive())));

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
  // Optional: without Neon, the API stays available for legacy reads only.
  NEON_DATABASE_URL: z.string().trim().default(''),
  PURCHASE_ORDER_EDIT_COMPANY_ID: z.coerce.number().int().min(1).max(255).default(1),
  PURCHASE_ORDER_WAREHOUSES: z.string().trim().transform((value) => value.split(',').map((code) => code.trim().toUpperCase()))
    .pipe(z.array(z.string().regex(/^[A-Z0-9]{1,10}$/))).optional(),
  INVENTORY_MOVEMENTS_SOURCE: z.enum(['mysql', 'postgres']).default('mysql'),
  INVENTORY_CLASSIFICATION_PILOT_PRODUCTS: productPilots,
  INVENTORY_OTHER_DATA_PILOT_PRODUCTS: productPilots,
  INVENTORY_PRODUCT_EDIT_PILOT_PRODUCTS: productPilots,
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
