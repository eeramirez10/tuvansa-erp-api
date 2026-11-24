import { createHash } from 'node:crypto';
import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import { ConflictError } from '../../../../../shared/domain/errors/conflict-error.js';
import { NotFoundError } from '../../../../../shared/domain/errors/not-found-error.js';
import type { PostingReversalFiscalWindow, PostingReversalInput, PostingReversalReferences } from '../../domain/datasources/purchase-posting-reversal-data-source.js';
import type {
  PurchaseReceptionCancellationDataSource, ReceiptCancellationReferences, ReceiptCancellationSource,
} from '../../domain/datasources/purchase-reception-cancellation-data-source.js';
import type { PurchaseReceptionActor } from '../../domain/datasources/purchase-reception-write-data-source.js';
import { undoPurchaseOrderReceipt } from '../../domain/entities/purchase-reception-cancellation.js';

const mexicoDate = new Intl.DateTimeFormat('sv-SE', { dateStyle: 'short', timeZone: 'America/Mexico_City' });
const nonzeroPieces = (pieces: string) => !/^(?:0+(?:\.0+)?)?$/.test(pieces.trim());
const quantity = (value: number) => Number(value.toFixed(3));
const block = (reason: string) => new ConflictError(reason, 'PURCHASE_RECEPTION_CANCELLATION_BLOCKED');
const invalidDate = (reason: string) => new ApplicationError(reason, 'PURCHASE_RECEPTION_CANCELLATION_INVALID_DATE', 422);

function blockedSource(source: ReceiptCancellationSource) {
  if (source.piecesInvoiced) return 'Hay piezas de la recepción que ya se utilizaron en una factura.';
  const { header, lines } = source.movement;
  if (source.alreadyRecorded || source.receipt.cancelled) return 'La recepción ya fue cancelada.';
  if (source.historical?.blockedReason) return source.historical.blockedReason;
  if (source.orderRetired) return 'La orden de esta recepción fue dada de baja.';
  if (header.type !== 'RA' || header.inventoryFlag !== 1 || !lines.length || !header.warehouse || !source.receipt.dates.receivedAt) {
    return 'El documento original requiere una cancelación distinta.';
  }
  if (!source.payable || source.payable.currencyId !== 1 || source.payable.exchangeRate !== 1 || source.payable.amount <= 0
    || source.accounting?.type !== '3' || !source.accounting.lines.length) {
    return 'La cancelación requiere una recepción en pesos con cargo y póliza registrados.';
  }
  if ((!source.historical && source.receipt.totals.pieces !== 0) || source.receipt.lines.some((line) => nonzeroPieces(line.pieces))
    || lines.some((line) => line.pieces !== 0 || nonzeroPieces(line.piecesText))) {
    return 'La recepción contiene piezas que requieren su propia cancelación.';
  }
  const receiptLots = new Map(source.receipt.lines.filter(({ lotId }) => lotId !== 0).map((line) => [line.id, line]));
  const movementLots = lines.filter(({ lotId }) => lotId !== 0);
  if ((receiptLots.size > 0 || movementLots.length > 0) && (source.historical || receiptLots.size !== movementLots.length
    || new Set(movementLots.map(({ lotId }) => lotId)).size !== movementLots.length
    || movementLots.some(({ id, lotId, productId, quantity, lotWarehouse, warehouse }) => {
      const receipt = receiptLots.get(id);
      return !Number.isSafeInteger(lotId) || lotId <= 0 || receipt?.lotId !== lotId
        || receipt.productId !== productId || receipt.quantity !== quantity || (lotWarehouse ?? warehouse) !== warehouse;
    }))) {
    return 'Las capas de la recepción requieren un origen PEPS conciliado.';
  }
  if (source.paymentActive) return 'La recepción tiene un pago PP activo. Revierte primero ese pago.';
  return null;
}

function earliestDate(source: ReceiptCancellationSource) {
  const original = source.receipt.dates.receivedAt ?? '';
  return source.lastReversalDate && source.lastReversalDate > original ? source.lastReversalDate : original;
}

function blockedPeriod(source: ReceiptCancellationSource, period: PostingReversalFiscalWindow | null) {
  if (!period) return 'No está configurado el periodo contable de la compañía.';
  const date = source.receipt.dates.receivedAt ?? '';
  if (date < period.fiscalStart || date > period.fiscalEnd) return 'La recepción original queda fuera del periodo contable activo.';
  if (earliestDate(source) > period.fiscalEnd) return 'La última reversión PP queda fuera del periodo contable activo.';
  return null;
}

export class CancelPurchaseReception {
  constructor(
    private readonly dataSource: PurchaseReceptionCancellationDataSource,
    private readonly references: ReceiptCancellationReferences,
    private readonly fiscal: PostingReversalReferences,
  ) {}

  private async checkSource(companyId: number, receiptId: number) {
    const source = await this.dataSource.source(companyId, receiptId);
    if (!source) throw new NotFoundError('Recepción de compra');
    return source;
  }

  private async changes(source: ReceiptCancellationSource) {
    const order = await this.references.cancellationOrder(source.orderId);
    if (!order || order.stale || (!source.historical && order.revision <= 0) || order.order.number !== source.orderNumber) {
      throw block('La orden original cambió o dejó de estar disponible.');
    }
    const effect = undoPurchaseOrderReceipt(order.order, source.orderLineEffects);
    const warehouse = source.movement.header.warehouse;
    const quantities = new Map<number, number>();
    for (const { productId, quantity: units, warehouse: lineWarehouse } of source.movement.lines) {
      if (!Number.isSafeInteger(productId) || productId <= 0 || !Number.isFinite(units) || units <= 0 || lineWarehouse !== warehouse) {
        throw block('La recepción contiene partidas de inventario incompatibles con la cancelación.');
      }
      quantities.set(productId, quantity((quantities.get(productId) ?? 0) + units));
    }
    const orderedQuantities = new Map<number, number>();
    for (const { productId, baseQuantity } of source.orderLineEffects) {
      orderedQuantities.set(productId, quantity((orderedQuantities.get(productId) ?? 0) + baseQuantity));
    }
    if (orderedQuantities.size !== quantities.size || [...quantities].some(([product, units]) => orderedQuantities.get(product) !== units)) {
      throw block('Las cantidades de la recepción ya no coinciden con su movimiento de inventario.');
    }
    const legacy = await this.references.inventory(warehouse, [...quantities.keys()]);
    const requests = [...quantities].map(([productId, units]) => {
      const data = legacy.get(productId);
      if (!data || ![data.onHand, data.assigned].every(Number.isFinite)) throw block('Ya no está disponible el registro de inventario de una partida.');
      return { productId, quantity: units, legacyOnHand: data.onHand, legacyAssigned: data.assigned };
    });
    const { id, number, lines, totals, status, received } = effect.order;
    const layers = source.movement.lines.filter(({ lotId }) => lotId !== 0).map(({ lotId, productId, quantity }) => ({ lotId, productId, quantity }));
    return {
      order: { id, number, lines, totals, receiving: { status, received }, revision: order.revision,
        legacyVersion: order.legacyVersion, amountInWords: order.amountInWords },
      pending: effect.stock, supplierRevision: order.supplierRevision, stock: {
        warehouse, requests, ...(layers.length ? { layers: { receiptId: source.id, lines: layers } } : {}),
      },
    };
  }

  async prepare(companyId: number, receiptId: number) {
    const [source, period] = await Promise.all([this.checkSource(companyId, receiptId), this.fiscal.fiscalWindow(companyId)]);
    let reason = blockedSource(source) ?? blockedPeriod(source, period);
    if (!reason) {
      try { await this.dataSource.checkStock((await this.changes(source)).stock); }
      catch (error) {
        if (!(error instanceof ConflictError)) throw error;
        reason = error.message;
      }
    }
    let date = mexicoDate.format();
    if (date < earliestDate(source)) date = earliestDate(source);
    if (period && date < period.fiscalStart) date = period.fiscalStart;
    if (period && date > period.fiscalEnd) date = period.fiscalEnd;
    const amount = source.payable?.amount ?? source.receipt.totals.total;
    return {
      canWrite: !reason, reason, number: source.receipt.number, policyNumber: source.accounting?.number ?? '',
      originalDate: source.receipt.dates.receivedAt ?? '', date: source.alreadyRecorded?.date ?? date,
      fiscalStart: period?.fiscalStart ?? null, fiscalEnd: period?.fiscalEnd ?? null,
      amount, documents: [{ id: receiptId, number: source.receipt.number, total: amount }], alreadyRecorded: source.alreadyRecorded,
    };
  }

  async save(actor: PurchaseReceptionActor, receiptId: number, input: PostingReversalInput) {
    const fingerprint = createHash('sha256').update(JSON.stringify([receiptId, input.date, input.reason])).digest('hex');
    const replay = await this.dataSource.findRequest(actor.companyId, input.requestKey, fingerprint);
    if (replay) return replay;
    const [source, period] = await Promise.all([this.checkSource(actor.companyId, receiptId), this.fiscal.fiscalWindow(actor.companyId)]);
    const validate = (current: ReceiptCancellationSource) => {
      const blocked = blockedSource(current);
      if (blocked) throw block(blocked);
      const periodReason = blockedPeriod(current, period);
      if (periodReason) throw invalidDate(periodReason);
      if (!period || input.date < period.fiscalStart || input.date > period.fiscalEnd || input.date < earliestDate(current)) {
        throw invalidDate('La fecha debe estar en el periodo activo y ser igual o posterior a la recepción y a la última reversión PP.');
      }
    };
    validate(source);
    return this.dataSource.commit({ actor, input, fingerprint, source, ...await this.changes(source), validate });
  }
}
