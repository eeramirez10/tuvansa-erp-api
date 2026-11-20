import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import {
  closePostgresPool,
  connectPostgres,
} from '../src/shared/infrastructure/database/postgres-pool.js';
import { migrateInventoryMovements } from '../src/modules/inventories/movements/infrastructure/datasources/postgres-inventory-movements-schema.js';
import { stageInventoryMovements } from '../src/modules/inventories/movements/infrastructure/datasources/postgres-inventory-movements-snapshot.js';
import { ApplicationError } from '../src/shared/domain/errors/application-error.js';

const id = z.int().positive();
const text = z.string();
const count = z.int().nonnegative();
const amount = z.number();
const decimal = z.string().regex(/^[+-]?\d{1,24}(?:\.\d{1,12})?$/);
const decision = z.boolean().nullable();

const snapshotSchema = z.object({
  policy: z.object({ warehouseTracking: decision, layerEffects: decision, transitEffects: decision }),
  documents: z.array(z.object({
    header: z.object({
      id, document: text.min(1), date: z.iso.date(), reference: text, reference2: text,
      warehouse: text, supplierCode: text, customerCode: text, customerName: text,
      type: text, status: count, company: count, userId: count, inventoryFlag: count, billingFlag: count,
    }),
    lines: z.array(z.object({
      id, productId: id, productCode: text.min(1), description: text, quantity: amount,
      unit: text, cost: amount, pieces: amount, piecesText: text, warehouse: text,
      type: text, lotId: count, userId: count,
    })),
    totals: z.object({ quantity: amount, cost: amount }),
  })).min(1),
  products: z.array(z.object({ productId: id, quantity: decimal, pieces: decimal })).min(1),
  warehouses: z.array(z.object({ productId: id, warehouse: text.min(1), quantity: decimal })),
});

const [action, file, ...extra] = process.argv.slice(2);
if (action !== '--snapshot' || !file || extra.length > 0) {
  console.error('Uso: pnpm exec tsx scripts/stage-postgres-inventory-movements.ts --snapshot <archivo>');
  process.exitCode = 1;
} else {
  try {
    const snapshot = snapshotSchema.parse(JSON.parse(await readFile(file, 'utf8')) as unknown);
    const client = await connectPostgres();
    try {
      await migrateInventoryMovements(client);
    } finally {
      client.release();
    }
    await stageInventoryMovements(connectPostgres, snapshot);
    console.log(`Documentos de inventario preparados en PostgreSQL (${snapshot.documents.length}).`);
  } catch (error) {
    console.error(error instanceof ApplicationError
      ? `No se pudo preparar la apertura (${error.code}).`
      : 'No se pudo preparar la apertura. Revisa el archivo y el destino PostgreSQL.');
    process.exitCode = 1;
  } finally {
    await closePostgresPool();
  }
}
