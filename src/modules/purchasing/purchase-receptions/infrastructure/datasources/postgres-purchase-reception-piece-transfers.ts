import { ConflictError } from '../../../../../shared/domain/errors/conflict-error.js';
import type { PostgresClient } from '../../../../../shared/infrastructure/database/postgres-pool.js';
import { isLocalPurchaseOrderId } from '../../../purchase-orders/domain/datasources/purchase-order-create-data-source.js';
import { purchaseOrderPieceIdStart, type PurchaseOrderPieceGroup } from '../../../purchase-orders/domain/datasources/purchase-order-pieces-data-source.js';
import type { PurchaseOrderProps } from '../../../purchase-orders/domain/entities/purchase-order.js';
import type { NativeReceiptPiece, PurchaseOrderPieceTransferReferences } from '../../domain/datasources/purchase-reception-pieces-data-source.js';
import type { PurchaseReceptionProps } from '../../domain/entities/purchase-reception.js';
import { lockPurchasePieceSerials, movedPurchasePieceOrigins, receiptUsesPieceSerial } from './purchase-reception-piece-reads.js';

const conflict = (message: string) => new ConflictError(message, 'PURCHASE_RECEPTION_PIECE_TRANSFER_CONFLICT');

async function checkSerials(
  client: PostgresClient, order: PurchaseOrderProps, pieces: NativeReceiptPiece[], references?: PurchaseOrderPieceTransferReferences,
) {
  const bySerial = new Map(pieces.map((piece) => [piece.serialNumber, piece.id]));
  const serials = [...bySerial.keys()];
  const ids = pieces.map(({ id }) => id);
  if (serials.length !== pieces.length || new Set(ids).size !== ids.length || await receiptUsesPieceSerial(client, serials)) {
    throw conflict('Una serie de la orden ya está registrada en otra pieza.');
  }
  const matches = await references?.matchingSerials(serials) ?? [];
  if (matches.some(({ id, serialNumber }) => bySerial.get(serialNumber) !== id)) {
    throw conflict('Una serie de la orden ya está registrada en otra pieza de Omnis.');
  }
  const { rows } = await client.query(
    `SELECT 1 FROM tuvansa.purchase_order_pieces saved CROSS JOIN LATERAL jsonb_array_elements(saved.items) item
     WHERE item->>'serial'=ANY($1::text[]) AND NOT
       (saved.order_id=$2 AND saved.order_number=$3 AND (item->>'id')::bigint=ANY($4::bigint[])) LIMIT 1`,
    [serials, order.id, order.number, ids],
  );
  if (rows.length) throw conflict('Una serie de la orden ya está registrada en otra pieza de compra.');
}

export async function transferPurchaseOrderPieces(
  client: PostgresClient, companyId: number, order: PurchaseOrderProps, receipt: PurchaseReceptionProps,
  references?: PurchaseOrderPieceTransferReferences,
) {
  const { rows: groups } = await client.query<PurchaseOrderPieceGroup>(
    `SELECT product_code AS "productCode",items FROM tuvansa.purchase_order_pieces
     WHERE order_id=$1 AND order_number=$2`, [order.id, order.number],
  );
  const raw = isLocalPurchaseOrderId(order.id) ? [] : await references?.orderPieces(companyId, order) ?? [];
  const native = raw.filter(({ invoiceNumber, receiptNumber }) => invoiceNumber === order.number && receiptNumber === order.number);
  const nativeById = new Map(native.map((piece) => [piece.id, piece]));
  const overridden = new Set(groups.map(({ productCode }) => productCode));
  const local = groups.flatMap(({ items }) => items)
    .filter(({ document, receipt: received }) => document === order.number && received === order.number);
  const candidates = [...native.filter(({ productCode }) => !overridden.has(productCode)), ...local];
  if (!candidates.length) return;

  await lockPurchasePieceSerials(client);
  const moved = await movedPurchasePieceOrigins(candidates.map(({ id }) => id), client);
  if ([...moved.values()].some(({ orderId, orderNumber }) => orderId !== order.id || orderNumber !== order.number)) {
    throw conflict('Una pieza de la orden ya se trasladó desde otro documento.');
  }
  const productIds = new Map<string, Set<number>>();
  for (const { productCode, productId } of order.lines) {
    const ids = productIds.get(productCode) ?? new Set<number>();
    ids.add(productId);
    productIds.set(productCode, ids);
  }
  const pieces: NativeReceiptPiece[] = native.filter(({ id, productCode }) => !overridden.has(productCode) && !moved.has(id));
  for (const item of local) {
    if (moved.has(item.id)) continue;
    const original = nativeById.get(item.id);
    if (item.id < purchaseOrderPieceIdStart && !original) throw conflict('El vínculo de una pieza de la orden cambió en Omnis.');
    const ids = productIds.get(item.productCode);
    if (!original && (ids?.size !== 1 || ids.has(0))) throw conflict('Una pieza no tiene un producto único en la orden.');
    pieces.push({
      id: item.id, productId: original?.productId ?? [...ids!][0]!, productCode: item.productCode,
      serialNumber: item.serial, pieces: item.pieces, quantity: item.quantity, warehouse: item.warehouse,
      orderNumber: original?.orderNumber ?? '', reference: original?.reference ?? '', date: original?.date ?? null,
      receiptNumber: item.receipt, invoiceNumber: item.document, customsEntry: original?.customsEntry ?? '',
      importDate: original?.importDate ?? null, customsOffice: original?.customsOffice ?? '', notes: original?.notes ?? '',
    });
  }
  if (!pieces.length) return;
  if (pieces.some(({ id, productId, serialNumber, quantity }) => !Number.isSafeInteger(id) || id <= 0
    || !Number.isSafeInteger(productId) || productId <= 0 || !serialNumber.trim() || !Number.isFinite(quantity))) {
    throw conflict('Una pieza de la orden tiene datos incompletos.');
  }
  await checkSerials(client, order, pieces, references);

  // MRECEP/110: se mueve todo el conjunto, sin repartir por partida o cantidad.
  const delivered = pieces.map((piece) => ({
    ...piece, warehouse: receipt.warehouse, date: receipt.dates.receivedAt, receiptNumber: receipt.number,
    invoiceNumber: '', orderNumber: '',
  }));
  await client.query(
    `INSERT INTO tuvansa.purchase_reception_pieces
       (id,company_id,receipt_id,receipt_number,product_id,original_serial,serial,quantity,piece,source_order_id,source_order_number)
     SELECT (piece->>'id')::bigint,$1,$2,$3,(piece->>'productId')::bigint,piece->>'serialNumber',piece->>'serialNumber',
       (piece->>'quantity')::numeric,piece,$4,$5
     FROM jsonb_array_elements($6::jsonb) piece`,
    [companyId, receipt.id, receipt.number, order.id, order.number, JSON.stringify(delivered)],
  );
  const movedIds = new Set(delivered.map(({ id }) => id));
  const remaining = groups.flatMap(({ productCode, items }) => {
    const kept = items.filter(({ id }) => !movedIds.has(id));
    return kept.length === items.length ? [] : [{ productCode, items: kept }];
  });
  if (remaining.length) {
    await client.query(
      `UPDATE tuvansa.purchase_order_pieces saved SET items=remaining.items
       FROM jsonb_to_recordset($3::jsonb) AS remaining("productCode" text,items jsonb)
       WHERE saved.order_id=$1 AND saved.order_number=$2 AND saved.product_code=remaining."productCode"`,
      [order.id, order.number, JSON.stringify(remaining)],
    );
  }
}
