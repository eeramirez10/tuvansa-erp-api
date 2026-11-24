import { createHash } from 'node:crypto';
import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import { ConflictError } from '../../../../../shared/domain/errors/conflict-error.js';
import { NotFoundError } from '../../../../../shared/domain/errors/not-found-error.js';
import type { PostingReversalFiscalWindow, PostingReversalReferences } from '../../../../purchasing/purchase-receptions/domain/datasources/purchase-posting-reversal-data-source.js';
import type { OrderProps } from '../../../orders/domain/entities/order.js';
import type {
  SalesRemissionCancellationDataSource, SalesRemissionCancellationInput, SalesRemissionCancellationSource,
} from '../../domain/datasources/sales-remission-cancellation-data-source.js';

const mexicoDate = new Intl.DateTimeFormat('sv-SE', { dateStyle: 'short', timeZone: 'America/Mexico_City' });
const blocked = (reason: string) => new ConflictError(reason, 'SALES_REMISSION_CANCELLATION_BLOCKED');
const invalidDate = (reason: string) => new ApplicationError(reason, 'SALES_REMISSION_CANCELLATION_INVALID_DATE', 422);
const changedOrder = () => new ConflictError('El pedido y las partidas de la remisión ya no coinciden.', 'SALES_REMISSION_CANCELLATION_ORDER_CHANGED');
const quantity = (value: number) => Number(value.toFixed(3));
const money = (value: number) => Number(value.toFixed(2));

function blockingReason(source: SalesRemissionCancellationSource) {
  const { invoice, movement, lineEffects, hasCollection, alreadyRecorded } = source;
  if (alreadyRecorded || invoice.canceled) return 'La remisión ya fue cancelada.';
  if (source.historical?.blockedReason) return source.historical.blockedReason;
  if (invoice.cfdStatus !== '0' || invoice.folio.trim() !== '') return 'El documento tiene un estado fiscal o folio de timbrado.';
  if (invoice.movementType !== 'FA' || movement.header.type !== 'FA' || movement.header.inventoryFlag !== 1
    || invoice.currency.id !== 1 || invoice.currency.exchangeRate !== 1 || source.charge <= 0
    || !source.warehouse || !lineEffects.length || movement.lines.length !== lineEffects.length
    || invoice.lines.length !== lineEffects.length) return 'El documento requiere una cancelación distinta.';
  if (invoice.lines.some(({ pieces }) => pieces !== 0) || movement.lines.some(({ lotId, lotWarehouse, pieces, piecesText }, index) => {
    const layer = invoice.lines[index]?.inventoryLayer;
    const validLayer = lotId === 0 ? !layer : !source.historical && Number.isSafeInteger(lotId) && lotId > 0
      && lotWarehouse && layer?.id === lotId && layer.warehouse === lotWarehouse;
    return !validLayer || pieces !== 0 || !/^(?:0+(?:\.0+)?)?$/.test(piecesText.trim());
  })) {
    return 'La remisión tiene lotes o piezas que requieren su propia cancelación.';
  }
  if (hasCollection) return 'La remisión tiene un cobro PA aplicado.';
  return null;
}

function periodReason(source: SalesRemissionCancellationSource, period: PostingReversalFiscalWindow | null) {
  if (!period) return 'No está configurado el periodo contable de la compañía.';
  if (source.issuedAt < period.fiscalStart || source.issuedAt > period.fiscalEnd) return 'La remisión original queda fuera del periodo contable activo.';
  if (source.lastCollectionReversalAt && source.lastCollectionReversalAt > period.fiscalEnd) return 'La última reversión PA queda fuera del periodo contable activo.';
  return null;
}

function regenerateOrder(source: SalesRemissionCancellationSource, order: OrderProps): OrderProps {
  if (order.id !== source.orderId || order.number !== source.orderNumber || order.documentKind !== 'order') throw changedOrder();
  const effects = new Map<number, { productId: number; quantity: number; unit: string }>();
  for (const [index, effect] of source.lineEffects.entries()) {
    const invoice = source.invoice.lines[index];
    if (!invoice || !Number.isFinite(effect.quantity) || effect.quantity <= 0) throw changedOrder();
    const unit = invoice.unit.trim();
    const previous = effects.get(effect.orderLineId);
    if (previous && (source.historical || !invoice.inventoryLayer || previous.unit !== unit || previous.productId !== effect.productId)) {
      throw changedOrder();
    }
    effects.set(effect.orderLineId, { productId: effect.productId, unit, quantity: quantity((previous?.quantity ?? 0) + effect.quantity) });
  }
  const lines = order.lines.map((line) => {
    const effect = effects.get(line.id);
    if (!effect) return line;
    effects.delete(line.id);
    if (line.productId !== effect.productId || line.unit.trim() !== effect.unit || quantity(line.fulfilled - effect.quantity) < 0) throw changedOrder();
    const fulfilled = quantity(line.fulfilled - effect.quantity);
    return { ...line, fulfilled, remaining: quantity(line.ordered - fulfilled) };
  });
  // MFACT/29 reduces historical PESURT by AIPRECIO * AICANTF with a floor of zero.
  const net = source.historical
    ? source.invoice.lines.reduce((total, line, index) => total + line.price * source.lineEffects[index]!.quantity, 0)
    : money(source.invoice.totals.subtotal - source.invoice.totals.discount);
  const remainingAmount = money(order.fulfilledAmount - net);
  const fulfilledAmount = source.historical ? Math.max(remainingAmount, 0) : remainingAmount;
  if (effects.size || !Number.isFinite(remainingAmount) || fulfilledAmount < 0) throw changedOrder();
  return {
    ...order, status: '', lines, fulfilledAmount,
    totals: { ...order.totals, fulfilled: quantity(lines.reduce((sum, line) => sum + line.fulfilled, 0)),
      remaining: quantity(lines.reduce((sum, line) => sum + line.remaining, 0)) },
  };
}

export class CancelSalesRemission {
  constructor(private readonly dataSource: SalesRemissionCancellationDataSource, private readonly fiscal: PostingReversalReferences) {}

  private async source(companyId: number, id: number) {
    const source = await this.dataSource.source(companyId, id);
    if (!source) throw new NotFoundError('Remisión');
    return source;
  }

  async prepare(companyId: number, id: number) {
    const [source, period] = await Promise.all([this.source(companyId, id), this.fiscal.fiscalWindow(companyId)]);
    const reason = blockingReason(source) ?? periodReason(source, period);
    let orderReason = source.historical?.orderReason ?? null;
    if (!orderReason) {
      try {
        if (!source.order) throw changedOrder();
        if (!reason) regenerateOrder(source, source.order);
      } catch (error) {
        if (!(error instanceof ConflictError)) throw error;
        orderReason = error.message;
      }
    }
    let date = mexicoDate.format();
    if (date < source.issuedAt) date = source.issuedAt;
    if (source.lastCollectionReversalAt && date < source.lastCollectionReversalAt) date = source.lastCollectionReversalAt;
    if (period && date < period.fiscalStart) date = period.fiscalStart;
    if (period && date > period.fiscalEnd) date = period.fiscalEnd;
    return {
      canWrite: !reason, reason, number: source.number, originalDate: source.issuedAt, date: source.alreadyRecorded?.date ?? date,
      fiscalStart: period?.fiscalStart ?? null, fiscalEnd: period?.fiscalEnd ?? null, amount: source.charge,
      order: { id: source.orderId, number: source.orderNumber, canRegenerate: !orderReason && !reason, reason: orderReason },
      alreadyRecorded: source.alreadyRecorded,
    };
  }

  async save(companyId: number, userId: number, id: number, input: SalesRemissionCancellationInput) {
    const fingerprint = createHash('sha256').update(JSON.stringify([id, input.date, input.reason, input.regenerateOrder])).digest('hex');
    const replay = await this.dataSource.findRequest(companyId, input.requestKey, fingerprint);
    if (replay) return replay;
    const [source, period] = await Promise.all([this.source(companyId, id), this.fiscal.fiscalWindow(companyId)]);
    const validate = (current: SalesRemissionCancellationSource) => {
      const reason = blockingReason(current);
      if (reason) throw blocked(reason);
      const invalidPeriod = periodReason(current, period);
      if (invalidPeriod) throw invalidDate(invalidPeriod);
      if (!period || input.date < current.issuedAt || input.date < period.fiscalStart || input.date > period.fiscalEnd) {
        throw invalidDate('La fecha debe estar en el periodo contable activo y ser igual o posterior a la remisión.');
      }
      if (current.lastCollectionReversalAt && input.date < current.lastCollectionReversalAt) {
        throw invalidDate(`La fecha debe ser igual o posterior a la última reversión PA (${current.lastCollectionReversalAt}).`);
      }
    };
    validate(source);
    if (input.regenerateOrder && (!source.order || source.historical?.orderReason)) throw changedOrder();
    return this.dataSource.commit({ companyId, userId, id, input, source, fingerprint, validate, regenerate: regenerateOrder });
  }
}
