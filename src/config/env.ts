import 'dotenv/config';
import { z } from 'zod';

const productPilots = z.string().default('')
  .transform((value) => value.trim() === '' ? [] : value.split(',').map((id) => id.trim()))
  .pipe(z.array(z.string().regex(/^[1-9]\d*$/).transform(Number).pipe(z.int().positive())));

const warehouseCodes = z.string().trim().transform((value) => value.split(',').map((code) => code.trim().toUpperCase()))
  .pipe(z.array(z.string().regex(/^[A-Z0-9]{1,10}$/)));

const salesOrderApprovers = z.string().default('[]').transform((value, ctx): unknown => {
  try { return JSON.parse(value); }
  catch {
    ctx.addIssue({ code: 'custom', message: 'Se esperaba una lista JSON de autorizadores de pedidos.' });
    return z.NEVER;
  }
}).pipe(z.array(z.strictObject({
  userId: z.number().int().positive().max(2147483647),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
})).refine((approvers) => new Set(approvers.map(({ sha256 }) => sha256)).size === approvers.length,
  'Cada clave de autorización debe corresponder a un solo usuario.'));

const purchaseOrderApprovers = z.string().default('[]').transform((value, ctx): unknown => {
  try { return JSON.parse(value); }
  catch {
    ctx.addIssue({ code: 'custom', message: 'Se esperaba una lista JSON de autorizadores de compra.' });
    return z.NEVER;
  }
}).pipe(z.array(z.object({
  userId: z.number().int().positive().max(2147483647),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  levels: z.array(z.enum(['A', 'B', 'C', 'D', 'E', 'F'])),
  supplierChange: z.boolean().default(false),
  supplierChangeAction: z.boolean().default(false),
}).strict().refine(({ levels, supplierChange, supplierChangeAction }) => levels.length > 0 || supplierChange || supplierChangeAction,
  'Cada autorizador debe tener un nivel de firma o permiso para cambiar proveedor.')).refine((approvers) => new Set(approvers.map(({ sha256 }) => sha256)).size === approvers.length,
  'Cada clave de autorización debe corresponder a un solo usuario.'));

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
  PURCHASE_ORDER_APPROVER_KEYS: purchaseOrderApprovers,
  PURCHASE_ORDER_WAREHOUSES: warehouseCodes.optional(),
  SALES_ORDER_APPROVER_KEYS: salesOrderApprovers,
  SALES_ORDER_WAREHOUSES: warehouseCodes.refine((codes) => codes.every((code) => code.length <= 6),
    'Los códigos de almacén de pedidos no pueden exceder seis caracteres.').default(['01']),
  INVENTORY_MOVEMENTS_SOURCE: z.enum(['mysql', 'postgres']).default('mysql'),
  INVENTORY_CLASSIFICATION_PILOT_PRODUCTS: productPilots,
  INVENTORY_OTHER_DATA_PILOT_PRODUCTS: productPilots,
  INVENTORY_PRODUCT_EDIT_PILOT_PRODUCTS: productPilots,
  LEGACY_DB_HOST: z.string().min(1).optional(),
  LEGACY_DB_PORT: z.coerce.number().int().positive().default(3306),
  LEGACY_DB_USER: z.string().min(1).optional(),
  LEGACY_DB_PASSWORD: z.string().optional(),
  LEGACY_DB_NAME: z.string().min(1).optional(),
  LEGACY_PRODUCT_PHOTOS_DIR: z.string().trim().optional(),
  LEGACY_DB_SSL: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
});

export const env = envSchema.parse(process.env);
