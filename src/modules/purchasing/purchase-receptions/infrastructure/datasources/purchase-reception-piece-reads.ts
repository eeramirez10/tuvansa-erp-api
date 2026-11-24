import { connectPostgres, postgresConfigured, type PostgresClient } from '../../../../../shared/infrastructure/database/postgres-pool.js';
import type { PurchaseReceptionProps } from '../../domain/entities/purchase-reception.js';
import type { PurchaseReceptionPanelResult } from '../../domain/repositories/purchase-receptions-repository.js';

export async function purchaseReceptionPiecesAvailable(client: PostgresClient) {
  const { rows: [table] } = await client.query<{ available: boolean }>(
    "SELECT to_regclass('tuvansa.purchase_reception_pieces') IS NOT NULL AS available",
  );
  return table?.available === true;
}

export function lockPurchaseReceptionPieces(client: PostgresClient, companyId: number, receiptId: number) {
  return client.query("SELECT pg_advisory_xact_lock(hashtextextended('purchase-reception-pieces:'||$1::text||':'||$2::text,0))", [companyId, receiptId]);
}

export function lockPurchasePieceSerials(client: PostgresClient) {
  return client.query('SELECT pg_advisory_xact_lock(715009)');
}

export async function receiptUsesPieceSerial(client: PostgresClient, serials: string[], excludedId?: number) {
  if (!serials.length || !await purchaseReceptionPiecesAvailable(client)) return false;
  const { rows } = await client.query(
    'SELECT 1 FROM tuvansa.purchase_reception_pieces WHERE serial=ANY($1::text[]) AND NOT retired AND ($2::bigint IS NULL OR id<>$2) LIMIT 1',
    [serials, excludedId ?? null],
  );
  return rows.length > 0;
}

export async function retirePurchaseReceptionPieces(client: PostgresClient, companyId: number, receiptId: number) {
  if (await purchaseReceptionPiecesAvailable(client)) {
    await client.query('UPDATE tuvansa.purchase_reception_pieces SET retired=true WHERE company_id=$1 AND receipt_id=$2 AND NOT retired', [companyId, receiptId]);
  }
}

async function readPieces<T>(fallback: T, read: (client: PostgresClient) => Promise<T>, transaction?: PostgresClient) {
  if (transaction) return await purchaseReceptionPiecesAvailable(transaction) ? read(transaction) : fallback;
  if (!postgresConfigured()) return fallback;
  const client = await connectPostgres();
  try { return await purchaseReceptionPiecesAvailable(client) ? await read(client) : fallback; }
  finally { client.release(); }
}

export function purchaseReceptionPieceProducts(productIds: number[], transaction?: PostgresClient) {
  if (!productIds.length) return Promise.resolve(new Set<number>());
  return readPieces(new Set<number>(), async (client) => {
    // FINV.ICONTROLPZAS stays enabled after an unused piece is retired in Proscai.
    const { rows } = await client.query<{ productId: number }>(
      'SELECT DISTINCT product_id::float8 AS "productId" FROM tuvansa.purchase_reception_pieces WHERE product_id=ANY($1::bigint[]) AND legacy_piece_id IS NULL',
      [productIds],
    );
    return new Set(rows.map(({ productId }) => productId));
  }, transaction);
}

export function receiptPieceSerialOverrides(nativePieceIds: number[]) {
  if (!nativePieceIds.length) return Promise.resolve(new Map<number, { originalSerial: string; serialNumber: string }>());
  return readPieces(new Map<number, { originalSerial: string; serialNumber: string }>(), async (client) => {
    const { rows } = await client.query<{ id: number; originalSerial: string; serialNumber: string }>(
      `SELECT legacy_piece_id::float8 AS id,original_serial AS "originalSerial",serial AS "serialNumber"
         FROM tuvansa.purchase_reception_pieces WHERE legacy_piece_id=ANY($1::bigint[]) AND NOT retired`,
      [nativePieceIds],
    );
    return new Map(rows.map(({ id, originalSerial, serialNumber }) => [id, { originalSerial, serialNumber }]));
  });
}

export interface ReceiptPieceLineOverride {
  receiptNumber: string;
  lineId: number;
  productId: number;
  baseQuantity: number;
  basePieces: string;
  pieces: string;
  revision: number;
}

export async function receiptPieceLineOverrides(client: PostgresClient, companyId: number, receiptId: number) {
  const { rows } = await client.query<ReceiptPieceLineOverride>(
    `SELECT receipt_number AS "receiptNumber",line_id::float8 AS "lineId",product_id::float8 AS "productId",base_quantity::float8 AS "baseQuantity",
       base_pieces AS "basePieces",pieces,revision FROM tuvansa.purchase_reception_piece_lines
     WHERE company_id=$1 AND receipt_id=$2`, [companyId, receiptId],
  );
  return rows;
}

export async function withReceiptPieceLines(receipt: PurchaseReceptionProps) {
  if (!receipt.lines.length) return receipt;
  const overrides = await readPieces<ReceiptPieceLineOverride[]>([], (client) => receiptPieceLineOverrides(client, 1, receipt.id));
  if (!overrides.length) return receipt;
  const byLine = new Map(overrides.map((row) => [row.lineId, row]));
  return { ...receipt, lines: receipt.lines.map((line) => {
    const override = byLine.get(line.id);
    return override?.receiptNumber === receipt.number && override.productId === line.productId && override.baseQuantity === line.invoicedQuantity
      && override.basePieces === line.pieces ? { ...line, pieces: override.pieces } : line;
  }) };
}

interface ReceiptPieceOverlay {
  legacyId: number | null;
  originalSerial: string;
  piece: Record<string, unknown>;
}

export async function withReceiptPieces(panel: PurchaseReceptionPanelResult) {
  const { id, number } = panel.purchaseReception;
  const overlays = await readPieces<ReceiptPieceOverlay[]>([], async (client) => (await client.query<ReceiptPieceOverlay>(
    `SELECT legacy_piece_id::float8 AS "legacyId",original_serial AS "originalSerial",piece
       FROM tuvansa.purchase_reception_pieces WHERE company_id=1 AND receipt_id=$1 AND receipt_number=$2 AND NOT retired ORDER BY id`, [id, number],
  )).rows);
  if (!overlays.length) return panel;
  const native = new Map(overlays.filter((row) => row.legacyId !== null).map((row) => [row.legacyId, row]));
  const originals = panel.items.map((item) => {
    const overlay = native.get(Number(item.id));
    return overlay && overlay.originalSerial === item.serialNumber ? { ...item, serialNumber: overlay.piece.serialNumber } : item;
  });
  return { ...panel, source: 'postgres' as const, items: [...originals, ...overlays.filter((row) => row.legacyId === null).map(({ piece }) => piece)] };
}
