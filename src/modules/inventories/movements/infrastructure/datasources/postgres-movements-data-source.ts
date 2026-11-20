import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import type { PostgresClient, PostgresConnectionFactory } from '../../../../../shared/infrastructure/database/postgres-pool.js';
import type { MovementCancellationDataSource, MovementsDataSource } from '../../domain/datasources/movements-data-source.js';
import type { MovementDocument, MovementHeader, MovementLine } from '../../domain/entities/inventory-movement.js';
import type { MovementSearchCriteria, MovementSearchResult } from '../../domain/repositories/movements-repository.js';
import { movementTransaction, readMovementPolicy } from './postgres-inventory-movements-snapshot.js';

interface DocumentRow {
  document: MovementDocument;
  cancelled: boolean;
}

const searchLimit = 1000;

const movementLines = `
  SELECT "productId" AS product_id, warehouse, quantity,
         coalesce(nullif("piecesText", ''), '0')::numeric AS pieces
  FROM jsonb_to_recordset($1::jsonb)
       AS lines("productId" bigint, warehouse text, quantity numeric, "piecesText" text)
`;

const productDeltas = `
  SELECT product_id, sum(quantity) AS quantity, sum(pieces) AS pieces
  FROM (${movementLines}) AS lines GROUP BY product_id
`;

const warehouseDeltas = `
  SELECT product_id, warehouse, sum(quantity) AS quantity, sum(pieces) AS pieces
  FROM (${movementLines}) AS lines GROUP BY product_id, warehouse
`;

const issue = (message: string, code = 'INVENTORY_MOVEMENT_UNSUPPORTED') =>
  new ApplicationError(message, code, 409);

const notOwned = () => issue(
  'Este movimiento pertenece a PROSCAI. La anulación requiere una copia de apertura conciliada en PostgreSQL.',
  'INVENTORY_MOVEMENT_NOT_OWNED',
);

const missingBalance = (scope: 'producto' | 'almacén') => issue(
  `Falta el saldo de ${scope} necesario para anular este movimiento.`,
  'INVENTORY_MOVEMENT_BALANCE_MISSING',
);

const validLine = (line: MovementLine): boolean => {
  if (typeof line.piecesText !== 'string' || typeof line.type !== 'string'
    || typeof line.warehouse !== 'string') return false;
  const pieces = line.piecesText.trim();
  const type = line.type.trim().toUpperCase();
  return Number.isSafeInteger(line.productId) && line.productId > 0 && Number.isFinite(line.quantity)
    && line.lotId === 0 && type !== '' && type !== 'K'
    && (/^[+-]?\d+(?:\.\d+)?$/.test(pieces) || (pieces === '' && line.pieces === 0));
};

const movementParameters = (lines: MovementLine[]): [string] => [
  JSON.stringify(lines.map(({ productId, warehouse, quantity, piecesText }) => ({
    productId, warehouse: warehouse.trim(), quantity, piecesText: piecesText.trim(),
  }))),
];

const loadDocument = async (client: PostgresClient, id: number, forUpdate = false) =>
  (await client.query<DocumentRow>(
    `SELECT original_document AS document, cancelled_at IS NOT NULL AS cancelled
     FROM tuvansa.inventory_movement_documents WHERE id = $1${forUpdate ? ' FOR UPDATE' : ''}`,
    [id],
  )).rows[0];

const evaluateCancellation = async (
  client: PostgresClient,
  row: DocumentRow,
): Promise<{ tracking: boolean } | ApplicationError> => {
  const { header, lines } = row.document;
  if (row.cancelled) return issue('El movimiento ya está anulado.', 'INVENTORY_MOVEMENT_CANCELLED');
  if (typeof header.document !== 'string' || header.document.trim() === ''
    || !Number.isInteger(header.inventoryFlag) || header.inventoryFlag === 0
    || header.billingFlag !== 0 || header.status !== 0 || header.company !== 1) {
    return issue('Sólo se pueden anular movimientos vigentes de inventario de la compañía 1 y sin facturación.');
  }

  const policy = await readMovementPolicy(client);
  if (!policy || policy.warehouseTracking === null || policy.layerEffects !== false || policy.transitEffects !== false) {
    return issue('Se requiere confirmar el seguimiento de almacén y la ausencia de efectos de capas o tránsito.');
  }
  if (/^[IJ]\d/i.test(header.document.trim())) {
    return issue('El folio corresponde a un flujo de tránsito que requiere una validación específica.');
  }
  if (lines.length === 0 || lines.some((line) => !validLine(line))) {
    return issue('El documento tiene partidas vacías, anuladas, con lote o sin datos de inventario válidos.');
  }
  const tracking = policy.warehouseTracking;
  if (tracking && lines.some(({ warehouse }) => warehouse.trim() === '')) {
    return issue('Falta el almacén de una partida que afecta existencias.');
  }

  const parameters = movementParameters(lines);
  if (lines.some(({ quantity }) => quantity > 0) && lines.some(({ quantity }) => quantity < 0)) {
    if (!tracking) return issue('Un traspaso debe tener seguimiento de existencias por almacén.');
    const transfer = await client.query<{ balanced: boolean }>(
      `SELECT coalesce(bool_and(quantity = 0 AND pieces = 0 AND warehouses >= 2), false) AS balanced
       FROM (
         SELECT sum(quantity) AS quantity, sum(pieces) AS pieces,
                count(*) FILTER (WHERE quantity <> 0) AS warehouses
         FROM (${warehouseDeltas}) AS deltas GROUP BY product_id
       ) AS products`,
      parameters,
    );
    if (transfer.rows[0]?.balanced !== true) {
      return issue('El traspaso debe compensar cantidades y piezas de cada producto entre almacenes.');
    }
  }

  const missingProduct = await client.query(
    `SELECT 1 FROM (${productDeltas}) AS delta
     LEFT JOIN tuvansa.inventory_movement_product_balances AS balance USING (product_id)
     WHERE balance.product_id IS NULL LIMIT 1`,
    parameters,
  );
  if (missingProduct.rows.length > 0) return missingBalance('producto');
  if (tracking) {
    const missingWarehouse = await client.query(
      `SELECT 1 FROM (${warehouseDeltas}) AS delta
       LEFT JOIN tuvansa.inventory_movement_warehouse_balances AS balance USING (product_id, warehouse)
       WHERE balance.product_id IS NULL LIMIT 1`,
      parameters,
    );
    if (missingWarehouse.rows.length > 0) return missingBalance('almacén');
  }
  return { tracking };
};

const reverseStock = async (client: PostgresClient, lines: MovementLine[], tracking: boolean): Promise<void> => {
  const parameters = movementParameters(lines);
  const updatedProducts = await client.query(
    `UPDATE tuvansa.inventory_movement_product_balances AS balance
     SET quantity = balance.quantity - delta.quantity, pieces = balance.pieces - delta.pieces
     FROM (${productDeltas}) AS delta
     WHERE balance.product_id = delta.product_id RETURNING balance.product_id`,
    parameters,
  );
  if (updatedProducts.rows.length !== new Set(lines.map(({ productId }) => productId)).size) {
    throw missingBalance('producto');
  }
  if (!tracking) return;

  const updatedWarehouses = await client.query(
    `UPDATE tuvansa.inventory_movement_warehouse_balances AS balance
     SET quantity = balance.quantity - delta.quantity
     FROM (${warehouseDeltas}) AS delta
     WHERE balance.product_id = delta.product_id AND balance.warehouse = delta.warehouse
     RETURNING balance.product_id`,
    parameters,
  );
  const warehouses = new Set(lines.map(({ productId, warehouse }) => JSON.stringify([productId, warehouse.trim()])));
  if (updatedWarehouses.rows.length !== warehouses.size) throw missingBalance('almacén');
};

// Derivada. Los movimientos de PostgreSQL cuentan con saldos propios de la apertura conciliada.
export class PostgresMovementsDataSource implements MovementsDataSource, MovementCancellationDataSource {
  constructor(private readonly connect: PostgresConnectionFactory) {}

  private async read<T>(operation: (client: PostgresClient) => Promise<T>): Promise<T> {
    const client = await this.connect();
    try {
      return await operation(client);
    } finally {
      client.release();
    }
  }

  search(criteria: MovementSearchCriteria): Promise<MovementSearchResult> {
    return this.read(async (client) => {
      const conditions = ["original_document #>> '{header,inventoryFlag}' = '1'"];
      const values: (number | string)[] = [];
      const filters = [
        ['document', criteria.document],
        ['reference', criteria.reference],
        ['reference2', criteria.reference2],
        ['warehouse', criteria.warehouse],
        ['supplierCode', criteria.supplier],
        ['customerCode', criteria.customer],
      ] as const;
      for (const [field, value] of filters) {
        if (value === undefined) continue;
        values.push(value.replace(/[!%_]/g, '!$&') + '%');
        conditions.push(`original_document #>> '{header,${field}}' ILIKE $${values.length} ESCAPE '!'`);
      }
      if (criteria.date !== undefined) {
        values.push(criteria.date);
        conditions.push(`original_document #>> '{header,date}' = $${values.length}`);
      }
      if (values.length === 0) return { items: [], total: 0 };
      const sortFields = [
        ['date', criteria.date],
        ['reference', criteria.reference],
        ['reference2', criteria.reference2],
        ['supplierCode', criteria.supplier],
        ['customerCode', criteria.customer],
      ] as const;
      const sort = sortFields.find(([, value]) => value !== undefined)?.[0] ?? 'document';
      const order = `lower(header->>'${sort}'), id`;
      values.push(searchLimit, criteria.limit, criteria.offset);
      const result = await client.query<{ items: MovementHeader[]; total: string }>(
        `WITH matched AS (
           SELECT id, original_document->'header' AS header
           FROM tuvansa.inventory_movement_documents WHERE ${conditions.join(' AND ')}
           ORDER BY lower(original_document #>> '{header,${sort}}'), id LIMIT $${values.length - 2}
         )
         SELECT (SELECT count(*)::text FROM matched) AS total,
           ARRAY(SELECT header FROM matched ORDER BY ${order}
                 LIMIT $${values.length - 1} OFFSET $${values.length}) AS items`,
        values,
      );
      return { items: result.rows[0]?.items ?? [], total: Number(result.rows[0]?.total ?? 0) };
    });
  }

  findById(id: number): Promise<MovementDocument | null> {
    return this.read(async (client) => {
      const result = await client.query<{ document: MovementDocument }>(
        `SELECT coalesce(cancelled_document, original_document) AS document
         FROM tuvansa.inventory_movement_documents WHERE id = $1`,
        [id],
      );
      return result.rows[0]?.document ?? null;
    });
  }

  canCancel(document: MovementDocument): Promise<string | null> {
    return this.read(async (client) => {
      const row = await loadDocument(client, document.header.id);
      if (!row) return notOwned().message;
      const result = await evaluateCancellation(client, row);
      return result instanceof ApplicationError ? result.message : null;
    });
  }

  cancel(id: number): Promise<void> {
    return movementTransaction(this.connect, async (client) => {
      const row = await loadDocument(client, id, true);
      if (!row) throw notOwned();
      if (row.cancelled) return;
      const eligibility = await evaluateCancellation(client, row);
      if (eligibility instanceof ApplicationError) throw eligibility;

      const { document } = row;
      await reverseStock(client, document.lines, eligibility.tracking);
      const cancelled: MovementDocument = {
        ...document,
        lines: document.lines.map((line) => ({
          ...line, quantity: 0, cost: 0, pieces: 0, piecesText: '', type: 'K',
        })),
        totals: { quantity: 0, cost: 0 },
      };
      await client.query(
        `UPDATE tuvansa.inventory_movement_documents
         SET cancelled_at = now(), cancelled_document = $2::jsonb WHERE id = $1`,
        [id, JSON.stringify(cancelled)],
      );
    });
  }
}
