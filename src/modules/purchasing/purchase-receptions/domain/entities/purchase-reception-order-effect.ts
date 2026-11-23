import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import type { PurchaseOrderLine, PurchaseOrderProps } from '../../../purchase-orders/domain/entities/purchase-order.js';

export interface PurchaseOrderReceiptLineInput {
  orderLineId: number;
  quantity: number;
}

export interface PurchaseOrderReceiptPolicy {
  receiveAssigned: boolean;
  supplierTolerancePercent: number;
  canRetireCompletedOrder: boolean;
}

export interface PurchaseOrderReceiptLineOption {
  orderLineId: number;
  productCode: string;
  description: string;
  unit: string;
  factor: number;
  ordered: number;
  fulfilled: number;
  assigned: number;
  suggested: number;
  maximum: number;
}

const invalid = (message: string) => new ApplicationError(message, 'INVALID_PURCHASE_RECEPTION', 422);
const quantity = (value: number) => Number(value.toFixed(3));
const money = (value: number) => Number(value.toFixed(2));
const validQuantity = (value: number) => Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER / 1000;

function receiptLineOption(line: PurchaseOrderLine, policy: PurchaseOrderReceiptPolicy): PurchaseOrderReceiptLineOption | null {
  const { id: orderLineId, productCode, description, unit, ordered, fulfilled, assigned } = line;
  const factor = line.factor === 0 ? 1 : line.factor;
  if (line.productId <= 0 || !productCode || !Number.isFinite(factor) || factor <= 0
    || ![ordered, fulfilled, assigned].every(validQuantity) || ordered <= 0
    || (ordered <= fulfilled && assigned <= 0)) return null;

  const tolerance = policy.supplierTolerancePercent > 0 ? 1 + policy.supplierTolerancePercent / 100 : 10;
  const limit = (ordered * tolerance - fulfilled) / factor;
  const maximum = Math.floor((limit + Number.EPSILON * Math.abs(limit)) * 1000) / 1000;
  const suggested = Math.min(quantity((policy.receiveAssigned ? assigned : ordered - fulfilled) / factor), maximum);
  if (!validQuantity(maximum) || suggested <= 0) return null;

  return { orderLineId, productCode, description, unit, factor, ordered, fulfilled, assigned, suggested, maximum };
}

export function purchaseOrderReceiptLines(order: PurchaseOrderProps, policy: PurchaseOrderReceiptPolicy): PurchaseOrderReceiptLineOption[] {
  if (order.documentKind !== 'order') return [];
  return order.lines.flatMap((line) => receiptLineOption(line, policy) ?? []);
}

export interface PurchaseOrderReceiptLineEffect {
  orderLineId: number;
  productId: number;
  capturedQuantity: number;
  baseQuantity: number;
  factor: number;
  previousFulfilled: number;
  fulfilled: number;
  previousAssigned: number;
  assigned: number;
  netAmount: number;
}

export interface PurchaseOrderReceiptStockEffect {
  productId: number;
  pendingDelta: number;
  assigned: number;
  assignedDelta: number;
}

export interface PurchaseOrderReceiptEffect {
  order: PurchaseOrderProps;
  lines: PurchaseOrderReceiptLineEffect[];
  stock: PurchaseOrderReceiptStockEffect[];
  assignmentMarker?: string;
  complete: boolean;
  retireCompletedOrder: boolean;
}

export function applyPurchaseOrderReceipt(
  order: PurchaseOrderProps,
  input: readonly PurchaseOrderReceiptLineInput[],
  policy: PurchaseOrderReceiptPolicy,
  retireCompletedOrder = false,
): PurchaseOrderReceiptEffect {
  if (order.documentKind !== 'order') throw invalid('Selecciona una orden de compra.');
  if (input.length === 0) throw invalid('Captura al menos una partida para recibir.');
  const selected = new Map(input.map(({ orderLineId, quantity }) => [orderLineId, quantity]));
  if (selected.size !== input.length) throw invalid('Cada partida de la orden debe aparecer una sola vez en la recepción.');

  const discountFactor = order.discountPercentages.reduce((factor, discount) => factor * (1 - discount / 100), 1);
  const lineEffects: PurchaseOrderReceiptLineEffect[] = [];
  const stock = new Map<number, PurchaseOrderReceiptStockEffect>();
  let assignmentMarker: string | undefined;

  const lines = order.lines.map((line): PurchaseOrderLine => {
    const capturedQuantity = selected.get(line.id);
    if (capturedQuantity === undefined) return line;
    selected.delete(line.id);

    const option = receiptLineOption(line, policy);
    if (!option) throw invalid(`La partida ${line.productCode} ya no está disponible para recibir.`);
    if (!validQuantity(capturedQuantity) || capturedQuantity <= 0 || capturedQuantity !== quantity(capturedQuantity)) {
      throw invalid(`Captura una cantidad positiva de hasta tres decimales para ${line.productCode}.`);
    }
    if (capturedQuantity > option.maximum) throw invalid(`La cantidad de ${line.productCode} excede la tolerancia del proveedor.`);
    const baseQuantity = quantity(capturedQuantity * option.factor);
    const fulfilled = quantity(line.fulfilled + baseQuantity);
    if (!validQuantity(fulfilled) || !validQuantity(baseQuantity) || baseQuantity <= 0) {
      throw invalid(`La cantidad de ${line.productCode} no es válida después de convertir la unidad.`);
    }

    const assigned = quantity(line.assigned - Math.min(baseQuantity, line.assigned));
    const assignedDelta = assigned - line.assigned;
    const pendingDelta = Math.max(line.ordered - fulfilled, 0) - Math.max(line.ordered - line.fulfilled, 0);
    const netAmount = money(capturedQuantity * (line.price * option.factor) * (1 - line.discount / 100) * discountFactor);
    if (!Number.isFinite(netAmount)) throw invalid(`El importe de ${line.productCode} no es válido.`);
    lineEffects.push({
      orderLineId: line.id, productId: line.productId, capturedQuantity, baseQuantity, factor: option.factor,
      previousFulfilled: line.fulfilled, fulfilled, previousAssigned: line.assigned, assigned, netAmount,
    });
    const effect = stock.get(line.productId) ?? { productId: line.productId, pendingDelta: 0, assigned: 0, assignedDelta: 0 };
    effect.pendingDelta += pendingDelta;
    effect.assignedDelta += assignedDelta;
    stock.set(line.productId, effect);
    if (assignedDelta !== 0) assignmentMarker = assignedDelta < 0 ? '' : 'ASIGNAD';

    return { ...line, fulfilled, assigned, remaining: quantity(line.ordered - fulfilled), confirmed: assigned !== 0 };
  });
  if (selected.size > 0) throw invalid('Una o más partidas no pertenecen a la orden de compra.');

  // The pending delta is incremental. Confirmed stock is stored as an absolute per-order, per-product quantity.
  let assigned = 0;
  for (const line of lines) {
    assigned += line.assigned;
    const effect = stock.get(line.productId);
    if (effect) effect.assigned += line.assigned;
  }

  const complete = !lines.some((line) => line.ordered > line.fulfilled);
  if (retireCompletedOrder && (!complete || !policy.canRetireCompletedOrder)) {
    throw invalid('La baja requiere una orden completamente surtida y una empresa que permita esta operación.');
  }

  const pieces = quantity(lineEffects.reduce((total, line) => total + line.baseQuantity, 0));
  const netAmount = money(lineEffects.reduce((total, line) => total + line.netAmount, 0));
  const fulfilled = quantity(order.totals.fulfilled + pieces);
  return {
    order: {
      ...order, lines, status: 'SURT',
      received: { quantity: money(order.received.quantity + netAmount), pieces: quantity(order.received.pieces + pieces) },
      totals: { ...order.totals, assigned: quantity(assigned), fulfilled, remaining: quantity(order.totals.ordered - fulfilled) },
    },
    lines: lineEffects,
    stock: [...stock.values()].map(({ productId, pendingDelta, assigned, assignedDelta }) => ({
      productId, pendingDelta: quantity(pendingDelta), assigned: quantity(assigned), assignedDelta: quantity(assignedDelta),
    })),
    ...(assignmentMarker === undefined ? {} : { assignmentMarker }),
    complete,
    retireCompletedOrder,
  };
}
