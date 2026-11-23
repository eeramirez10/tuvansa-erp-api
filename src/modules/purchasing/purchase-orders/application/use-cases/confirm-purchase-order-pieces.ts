import { createHash } from 'node:crypto';
import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import { ConflictError } from '../../../../../shared/domain/errors/conflict-error.js';
import { NotFoundError } from '../../../../../shared/domain/errors/not-found-error.js';
import type { PurchaseOrderConfirmationStorage } from '../../domain/datasources/purchase-order-confirmation-data-source.js';
import type { PurchaseOrderCreateStorage } from '../../domain/datasources/purchase-order-create-data-source.js';
import type { PurchaseOrderEditLegacyDataSource, PurchaseOrderEditSnapshot, PurchaseOrderEditStorage } from '../../domain/datasources/purchase-order-edit-data-source.js';
import type { PurchaseOrdersRepository } from '../../domain/repositories/purchase-orders-repository.js';
import { loadPurchaseOrderWriteContext } from './load-purchase-order-write-context.js';

type ConfirmPiecesInput = Pick<PurchaseOrderEditSnapshot, 'revision' | 'legacyVersion'>;

const quantity = (value: number) => Number(value.toFixed(3));

function pieceQuantity(value: unknown): number | null {
  const parsed = typeof value === 'number' || (typeof value === 'string' && value.trim() !== '')
    ? Number(value) : NaN;
  return Number.isFinite(parsed) ? quantity(parsed) : null;
}

export class ConfirmPurchaseOrderPieces {
  constructor(
    private readonly legacy: PurchaseOrderEditLegacyDataSource,
    private readonly storage: PurchaseOrderEditStorage & PurchaseOrderConfirmationStorage,
    private readonly creation: PurchaseOrderCreateStorage,
    private readonly orders: Pick<PurchaseOrdersRepository, 'findById' | 'getPanel'>,
  ) {}

  private async context(id: number) {
    const context = await loadPurchaseOrderWriteContext(id, this.legacy, this.storage, this.creation);
    const { base, documentKind, rules, stored, version, lines } = context;
    const panel = await this.orders.getPanel(id, 'pieces');
    if (panel?.purchaseOrder.number !== base.number) throw new NotFoundError('Orden de compra');

    const firstLineByCode = new Map<string, number>();
    for (const line of lines) {
      const first = firstLineByCode.get(line.productCode);
      if (line.productCode !== '' && (first === undefined || line.id < first)) {
        firstLineByCode.set(line.productCode, line.id);
      }
    }
    const pieces = panel.items.map((piece) => {
      const code = typeof piece.productCode === 'string' ? piece.productCode : '';
      return { id: String(piece.id ?? ''), code, lineId: firstLineByCode.get(code), quantity: pieceQuantity(piece.quantity) };
    });
    const previewVersion = createHash('sha256').update(JSON.stringify([version, pieces])).digest('hex');
    let reason = '';
    if (documentKind !== 'order') reason = 'La confirmación de piezas sólo está disponible para órdenes de compra.';
    else if (rules.companyId !== rules.activeCompanyId) reason = 'La orden pertenece a otra compañía.';
    else if (stored && stored.legacyVersion !== version) reason = 'La orden de origen cambió después de la edición en PostgreSQL.';
    else if (!this.storage.writable()) reason = 'La confirmación de piezas requiere PostgreSQL.';
    else if (quantity(lines.reduce((sum, line) => sum + line.assigned, 0)) > 0) reason = 'La orden de compra ya está confirmada.';
    else if (!pieces.length) reason = 'La orden no tiene piezas para confirmar.';
    else if (pieces.some((piece) => piece.lineId === undefined)) reason = 'Hay piezas cuyos productos no aparecen en las partidas de la orden.';
    else if (pieces.some((piece) => piece.quantity === null)) reason = 'Hay piezas con una cantidad inválida.';
    else if (pieces.every((piece) => piece.quantity === 0)) reason = 'Las cantidades de las piezas son cero.';
    return { ...context, previewVersion, pieces, reason };
  }

  async get(id: number) {
    const { base, stored, previewVersion, pieces, reason } = await this.context(id);
    return {
      id, number: base.number, revision: stored?.revision ?? 0, legacyVersion: previewVersion,
      canWrite: reason === '', reason, pieceCount: pieces.length,
    };
  }

  async execute(id: number, input: ConfirmPiecesInput) {
    const { base, stored, version, previewVersion, lines, pieces, reason } = await this.context(id);
    const revision = stored?.revision ?? 0;
    if (input.revision !== revision || input.legacyVersion !== previewVersion) {
      throw new ConflictError('La orden o sus piezas cambiaron. Vuelve a abrir Confirmar.', 'PURCHASE_ORDER_PIECES_CONFIRMATION_STALE');
    }
    if (reason) {
      throw new ApplicationError(reason, 'PURCHASE_ORDER_PIECES_CONFIRMATION_NOT_ALLOWED', this.storage.writable() ? 409 : 503);
    }

    const assignedByLine = new Map(lines.map((line) => [line.id, line.assigned]));
    let marker = '';
    for (const piece of pieces) {
      if (piece.lineId === undefined || !piece.quantity) continue;
      assignedByLine.set(piece.lineId, quantity((assignedByLine.get(piece.lineId) ?? 0) + piece.quantity));
      marker = piece.quantity > 0 ? 'ASIGNAD' : '';
    }

    const assignedByProduct = new Map<number, number>(base.lines.map((line) => [line.productId, 0]));
    let assignedTotal = 0;
    const updatedLines = lines.map((line) => {
      const assigned = assignedByLine.get(line.id) ?? line.assigned;
      assignedTotal += assigned;
      assignedByProduct.set(line.productId, (assignedByProduct.get(line.productId) ?? 0) + assigned);
      return assigned === line.assigned ? line : { ...line, assigned, confirmed: assigned !== 0 };
    });
    const stock = [...assignedByProduct].map(([productId, assigned]) => ({ productId, assigned: quantity(assigned) }));
    const totals = { ...(stored?.totals ?? base.totals), assigned: quantity(assignedTotal) };
    await this.storage.saveConfirmation({
      id, number: base.number, revision, legacyVersion: version, lines: updatedLines, totals,
      amountInWords: stored?.amountInWords ?? null,
    }, stock, base.classifications, marker);

    const order = await this.orders.findById(id);
    if (!order) throw new NotFoundError('Orden de compra');
    return order.toPrimitives();
  }
}
