import { ConflictError } from '../../../../../shared/domain/errors/conflict-error.js';
import type { PurchaseOrderProps } from '../../../purchase-orders/domain/entities/purchase-order.js';
import type { PurchaseOrderReceiptLineEffect } from './purchase-reception-order-effect.js';

const quantity = (value: number) => Number(value.toFixed(3));
const money = (value: number) => Number(value.toFixed(2));
const changed = () => new ConflictError('Las partidas de la orden ya no coinciden con la recepción registrada.', 'PURCHASE_RECEPTION_ORDER_CHANGED');

export function undoPurchaseOrderReceipt(order: PurchaseOrderProps, receipt: PurchaseOrderReceiptLineEffect[]) {
  if (order.documentKind !== 'order' || !receipt.length) throw changed();
  const effects = new Map(receipt.map((line) => [line.orderLineId, line]));
  if (effects.size !== receipt.length) throw changed();
  const stock = new Map<number, { productId: number; pendingDelta: number; assigned: number }>();
  const lines = order.lines.map((line) => {
    const effect = effects.get(line.id);
    if (!effect) return line;
    effects.delete(line.id);
    if (effect.productId !== line.productId || effect.factor !== (line.factor || 1)
      || !Number.isFinite(effect.baseQuantity) || effect.baseQuantity <= 0 || !Number.isFinite(effect.netAmount)
      || quantity(line.fulfilled - effect.baseQuantity) < 0) throw changed();
    const fulfilled = quantity(line.fulfilled - effect.baseQuantity);
    const pendingDelta = Math.max(line.ordered - fulfilled, 0) - Math.max(line.ordered - line.fulfilled, 0);
    const product = stock.get(line.productId) ?? { productId: line.productId, pendingDelta: 0, assigned: 0 };
    product.pendingDelta = quantity(product.pendingDelta + pendingDelta);
    stock.set(line.productId, product);
    return { ...line, fulfilled, remaining: quantity(line.ordered - fulfilled) };
  });
  if (effects.size) throw changed();

  // MRECEP/25 returns PLSURT without changing the order's current PLASIGN values.
  for (const { productId, assigned } of lines) {
    const product = stock.get(productId);
    if (product) product.assigned = quantity(product.assigned + assigned);
  }
  const pieces = quantity(order.received.pieces - receipt.reduce((total, line) => total + line.baseQuantity, 0));
  const receivedAmount = money(order.received.quantity - receipt.reduce((total, line) => total + line.netAmount, 0));
  if (pieces < 0 || receivedAmount < 0) throw changed();
  const fulfilled = quantity(lines.reduce((total, line) => total + line.fulfilled, 0));
  return {
    order: {
      ...order, lines, received: { pieces, quantity: receivedAmount },
      totals: { ...order.totals, fulfilled, remaining: quantity(order.totals.ordered - fulfilled) },
    },
    stock: [...stock.values()],
  };
}
