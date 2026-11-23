import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import { ConflictError } from '../../../../../shared/domain/errors/conflict-error.js';
import { NotFoundError } from '../../../../../shared/domain/errors/not-found-error.js';
import type { PurchaseOrderCreateStorage } from '../../domain/datasources/purchase-order-create-data-source.js';
import type { PurchaseOrderEditLegacyDataSource, PurchaseOrderEditStorage } from '../../domain/datasources/purchase-order-edit-data-source.js';
import {
  readPurchaseOrderPieces,
  type PurchaseOrderPiece,
  type PurchaseOrderPiecesInput,
  type PurchaseOrderPiecesStorage,
} from '../../domain/datasources/purchase-order-pieces-data-source.js';
import type { PurchaseOrdersRepository } from '../../domain/repositories/purchase-orders-repository.js';
import { loadPurchaseOrderWriteContext } from './load-purchase-order-write-context.js';

const invalid = (message: string) => new ApplicationError(message, 'INVALID_PURCHASE_ORDER_PIECES', 422);

export class EditPurchaseOrderPieces {
  constructor(
    private readonly legacy: PurchaseOrderEditLegacyDataSource,
    private readonly storage: PurchaseOrderEditStorage & PurchaseOrderPiecesStorage,
    private readonly creation: PurchaseOrderCreateStorage,
    private readonly orders: PurchaseOrdersRepository,
  ) {}

  private async context(id: number) {
    const state = await loadPurchaseOrderWriteContext(id, this.legacy, this.storage, this.creation);
    const { lines, rules, stored, version, documentKind } = state;
    const panel = await this.orders.getPanel(id, 'pieces');
    if (!panel) throw new NotFoundError('Orden de compra');
    const pieces = readPurchaseOrderPieces(panel.items);
    const revisionToken = createHash('sha256').update(JSON.stringify({ version, pieces })).digest('hex');
    const productMap = new Map<string, { productCode: string; description: string; ordered: number }>();
    for (const { productCode, description, ordered } of lines) {
      if (!productCode) continue;
      const current = productMap.get(productCode);
      productMap.set(productCode, { productCode, description, ordered: Number(((current?.ordered ?? 0) + ordered).toFixed(3)) });
    }
    let reason = '';
    if (documentKind !== 'order') reason = 'Alta Piezas está habilitado para órdenes de compra.';
    else if (rules.companyId !== rules.activeCompanyId) reason = 'La orden pertenece a otra compañía.';
    else if (stored && stored.legacyVersion !== version) reason = 'La orden de origen cambió.';
    else if (lines.reduce((total, line) => total + line.assigned, 0) > 0) reason = 'La orden de compra ya está confirmada.';
    else if (!productMap.size) reason = 'La orden no tiene productos.';
    else if (!this.storage.writable()) reason = 'Alta Piezas requiere PostgreSQL.';
    return { ...state, pieces, revisionToken, reason, products: [...productMap.values()] };
  }

  async get(id: number) {
    const { base, stored, pieces, revisionToken, reason, products } = await this.context(id);
    return { id, number: base.number, revision: stored?.revision ?? 0, legacyVersion: revisionToken,
      canWrite: !reason, reason, products, items: pieces };
  }

  async execute(id: number, input: PurchaseOrderPiecesInput) {
    const { base, stored, pieces, revisionToken, reason, lines, version, products } = await this.context(id);
    if (input.revision !== (stored?.revision ?? 0) || input.legacyVersion !== revisionToken) {
      throw new ConflictError('Las piezas o la orden cambiaron. Vuelve a abrir Alta Piezas.', 'PURCHASE_ORDER_PIECES_STALE');
    }
    if (reason) throw new ApplicationError(reason, 'PURCHASE_ORDER_PIECES_NOT_ALLOWED', this.storage.writable() ? 409 : 503);
    const { productCode } = input;
    if (!products.some((product) => product.productCode === productCode)) throw invalid('El producto no está en la orden.');
    const current = pieces.filter((piece) => piece.productCode === productCode);
    const existing = new Map(current.map((piece) => [piece.id, piece]));
    const seen = new Set<number>();
    const serials = new Set<string>();
    const updated: PurchaseOrderPiece[] = [];
    for (const { id: pieceId, serial, quantity } of input.entries) {
      const row = pieceId === null ? undefined : existing.get(pieceId);
      if (pieceId !== null && (!row || seen.has(pieceId))) {
        throw invalid('La pieza seleccionada ya no pertenece al producto.');
      }
      if (pieceId !== null) seen.add(pieceId);
      if (quantity === 0) continue;
      const selectedSerial = serial || row?.serial || '';
      if (selectedSerial && serials.has(selectedSerial)) throw invalid('Hay una serie repetida para el producto.');
      if (selectedSerial) serials.add(selectedSerial);
      updated.push(row ? { ...row, serial: selectedSerial, quantity } : {
        id: 0, productCode, serial: selectedSerial, pieces: 1, quantity,
        warehouse: stored?.comments?.fields.warehouse ?? base.warehouse, document: base.number, receipt: base.number,
      });
    }
    if (existing.size !== seen.size) throw invalid('Las piezas existentes se eliminan indicando cantidad cero.');
    if (!isDeepStrictEqual(updated, current)) {
      await this.storage.savePieces({
        id, number: base.number, revision: input.revision, legacyVersion: version, lines,
        totals: stored?.totals ?? base.totals, amountInWords: stored?.amountInWords ?? null,
      }, productCode, updated);
    }
    return this.get(id);
  }
}
