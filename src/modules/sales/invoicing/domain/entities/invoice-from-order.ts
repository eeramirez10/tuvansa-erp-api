import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import { ConflictError } from '../../../../../shared/domain/errors/conflict-error.js';
import { roundAmount, roundCapturePrice } from '../../../orders/domain/entities/order-capture-totals.js';
import { normalizeOrderWarehouse } from '../../../orders/domain/entities/order-warehouse.js';
import type { OrderLine, OrderProps } from '../../../orders/domain/entities/order.js';
import type {
  InvoiceFromOrderContext, InvoiceFromOrderInput, InvoiceFromOrderPosting, InvoiceFromOrderProduct, InvoiceFromOrderStock,
} from '../datasources/invoice-from-order-data-source.js';

const quantity = (value: number) => Math.round(value * 1_000) / 1_000;
const invalid = (message: string) => new ApplicationError(message, 'SALES_REMISSION_INVALID', 422);

export function invoiceOrderReason(order: OrderProps): string | null {
  if (order.documentKind !== 'order' || (order.storage && order.storage.legacyId !== null)) {
    return 'Selecciona un pedido local de venta.';
  }
  if (order.currencyId !== 0 || order.captureDetails?.collectionCurrency !== 'PESOS') {
    return 'Sólo se admiten pedidos capturados en pesos.';
  }
  if (order.authorization !== 'O.K.') return 'El pedido debe estar autorizado.';
  if (order.totals.freight || order.totals.insurance || order.totals.other || order.minimumFulfillmentPercentage
    || order.captureDetails.orderDiscounts?.[3]) {
    return 'El pedido requiere cargos, descuentos o un porcentaje de surtido fuera de la remisión estándar.';
  }
  if (!order.lines.some(({ assigned, ordered, fulfilled }) => assigned > 0 && ordered > fulfilled)) {
    return 'El pedido no tiene partidas asignadas pendientes de surtir.';
  }
  return null;
}

function productEligible(line: OrderLine, product: InvoiceFromOrderProduct | undefined): product is InvoiceFromOrderProduct {
  return Boolean(product?.supported && product.unit && product.unit.toUpperCase() === line.unit.trim().toUpperCase()
    && product.code === line.productCode.trim() && line.currencyId === 0 && line.price > 0 && !line.piecesAssignment.trim());
}

export function invoiceOrderLines(order: OrderProps, context: InvoiceFromOrderContext) {
  return order.lines.flatMap((line) => {
    const product = context.products.get(line.productId);
    const maximum = quantity(Math.min(line.assigned, line.ordered - line.fulfilled));
    if (!productEligible(line, product) || maximum <= 0) return [];
    return [{
      orderLineId: line.id, productCode: line.productCode, description: line.description, unit: line.unit,
      ordered: line.ordered, fulfilled: line.fulfilled, assigned: line.assigned, maximum, suggested: maximum,
    }];
  });
}

function addDays(date: string, days: number): string {
  const dueAt = new Date(date + 'T00:00:00Z');
  dueAt.setUTCDate(dueAt.getUTCDate() + days);
  return dueAt.toISOString().slice(0, 10);
}

export function postInvoiceFromOrder(
  order: OrderProps,
  context: InvoiceFromOrderContext,
  { issuedAt, lines }: InvoiceFromOrderInput,
  companyId: number,
  userId: number,
  localReceivableBalance: number,
): InvoiceFromOrderPosting {
  const reason = invoiceOrderReason(order) ?? context.reason;
  if (reason) throw new ConflictError(reason, 'SALES_REMISSION_UNAVAILABLE');
  if (issuedAt < context.fiscalStart || issuedAt > context.fiscalEnd) {
    throw invalid('La fecha de la remisión está fuera del ejercicio de facturación de la compañía.');
  }
  const requested = new Map(lines.map((line) => [line.orderLineId, line.quantity]));
  if (!requested.size || requested.size !== lines.length) throw invalid('Selecciona partidas distintas para remitir.');
  const indexes = new Map(order.lines.map((line) => [line.id, line]));
  const eligible = new Map(invoiceOrderLines(order, context).map((line) => [line.orderLineId, line]));
  for (const [id, submitted] of requested) {
    const option = eligible.get(id);
    if (!option || submitted <= 0 || quantity(submitted) !== submitted || submitted > option.maximum) {
      throw invalid('La partida ' + (indexes.get(id)?.productCode ?? id) + ' no tiene esa cantidad asignada en la unidad del pedido.');
    }
  }

  const updatedLines = order.lines.map((line) => {
    const delivered = requested.get(line.id);
    if (delivered === undefined) return line;
    const fulfilled = quantity(line.fulfilled + delivered);
    return { ...line, fulfilled, remaining: quantity(line.ordered - fulfilled), assigned: quantity(line.assigned - delivered) };
  });
  const orderComplete = updatedLines.every(({ remaining }) => remaining <= 0);
  if (order.captureDetails?.noPartialDeliveries && !orderComplete) {
    throw invalid('El pedido requiere surtir todas las partidas pendientes en una sola entrega.');
  }
  const discounts = order.captureDetails?.orderDiscounts?.slice(0, 3) ?? [0, 0, 0];
  const discountFactor = discounts.reduce((factor, percent) => factor * (1 - percent / 100), 1);
  const warehouse = normalizeOrderWarehouse(order.warehouse);
  const stock = new Map<number, InvoiceFromOrderStock>();
  const invoiceLines: InvoiceFromOrderPosting['invoice']['lines'] = [];
  const movementLines: InvoiceFromOrderPosting['movement']['lines'] = [];
  const lineEffects: InvoiceFromOrderPosting['lineEffects'] = [];
  let pieces = 0;
  let listSubtotal = 0;
  let grossSubtotal = 0;
  let movementCost = 0;
  for (const line of order.lines) {
    const delivered = requested.get(line.id);
    if (delivered === undefined) continue;
    const product = context.products.get(line.productId)!;
    const netPrice = roundCapturePrice(line.price * (1 - line.discount / 100) * discountFactor);
    invoiceLines.push({
      productId: line.productId, productCode: line.productCode, description: line.description,
      quantity: -delivered, fulfilledQuantity: delivered, unit: line.unit, price: netPrice, grossPrice: line.price,
      discount: line.discount, amount: roundAmount(delivered * netPrice), branch: line.branch,
      agent: order.classifications[0] ?? '', pieces: 0, page: 1, factor: 1, cost: product.cost,
      package: product.package, sku: line.sku, family: product.family,
    });
    movementLines.push({
      productId: line.productId, productCode: line.productCode, description: line.description, quantity: -delivered,
      unit: line.unit, cost: product.cost, pieces: 0, piecesText: '', warehouse, type: 'FA', lotId: 0, userId,
    });
    lineEffects.push({ orderLineId: line.id, productId: line.productId, quantity: delivered });
    const prior = stock.get(line.productId);
    stock.set(line.productId, {
      productId: line.productId, quantity: quantity((prior?.quantity ?? 0) + delivered),
      legacyOnHand: product.legacyOnHand, legacyAssigned: product.legacyAssigned,
    });
    pieces += delivered;
    grossSubtotal += delivered * line.price;
    listSubtotal += roundAmount(delivered * line.price * (1 - line.discount / 100));
    movementCost -= delivered * product.cost;
  }

  const subtotal = roundAmount(grossSubtotal);
  const net = roundAmount(listSubtotal - roundAmount(listSubtotal * (1 - discountFactor)));
  const tax = roundAmount(net * context.vat / 100);
  const total = roundAmount(net + tax);
  if (!Number.isFinite(total) || total <= 0) throw invalid('La remisión debe tener un total positivo.');
  const creditExcess = Math.trunc(roundAmount(context.creditBalance + localReceivableBalance + total - context.creditLimit));
  if (creditExcess > 0) {
    throw new ConflictError('La remisión excede el límite de crédito del cliente.', 'SALES_REMISSION_CREDIT_EXCEEDED');
  }
  const dueAt = addDays(issuedAt, order.termsDays || context.customerTermsDays);
  const units = quantity(pieces);
  const currentOrder = {
    ...order, lines: updatedLines, fulfilledAmount: roundAmount(order.fulfilledAmount + net), status: 'SURT',
    totals: {
      ...order.totals, fulfilled: quantity(updatedLines.reduce((sum, line) => sum + line.fulfilled, 0)),
      remaining: quantity(updatedLines.reduce((sum, line) => sum + line.remaining, 0)),
    },
  };
  return {
    order: currentOrder,
    invoice: {
      orderNumber: order.number, customerOrderNumber: order.customerOrderNumber,
      customer: { ...order.customer, billedName: order.customer.name },
      movementType: 'FA', status: '', canceled: false, dates: { issuedAt, dueAt, paidAt: null, deliveryNoteAt: null },
      delayDays: -(order.termsDays || context.customerTermsDays), attention: order.attention,
      attentionCode: order.classifications[0] ?? '', branch: order.branch, department: order.department, route: 0,
      pieces: units, warehouse, currency: { id: 1, name: 'PESOS', exchangeRate: 1 }, initial: order.initial,
      cfdStatus: '0', folio: '', deliveryNote: '', warehouseSeal: '', discountPercentages: discounts,
      totals: {
        quantity: -units, fulfilledQuantity: units, subtotal, discount: roundAmount(subtotal - net), freight: 0,
        insurance: 0, other: 0, exciseTax: 0, tax, total, paid: 0, balance: total,
      },
      lines: invoiceLines,
    },
    movement: {
      header: {
        date: issuedAt, reference: order.number, reference2: order.customerOrderNumber, warehouse, supplierCode: '',
        customerCode: order.customer.code, customerName: order.customer.name, type: 'FA', status: 0,
        company: companyId, userId, inventoryFlag: 1, billingFlag: 1,
      },
      lines: movementLines,
      totals: { quantity: -units, cost: roundAmount(movementCost) },
    },
    receivable: { amount: total, currencyId: 1, exchangeRate: 1, dueAt },
    lineEffects,
    stock: [...stock.values()].sort((first, second) => first.productId - second.productId),
    orderComplete,
  };
}
