import { ConflictError } from '../../../../../shared/domain/errors/conflict-error.js';
import { normalizeOrderWarehouse } from './order-warehouse.js';
import type { OrderProps } from './order.js';
import type { CaptureCurrencyId, CaptureInput, CaptureOrderDiscounts } from '../repositories/order-capture-repository.js';

const mexicoDate = new Intl.DateTimeFormat('sv-SE', { dateStyle: 'short', timeZone: 'America/Mexico_City' });
export const todayInMexico = () => mexicoDate.format();

export const duplicateStale = () => new ConflictError(
  'Cambió el pedido, el total o la fecha. Actualiza la vista previa antes de duplicar.', 'ORDER_DUPLICATE_STALE',
);

function unsupported(reason: string): never {
  throw new ConflictError(reason, 'ORDER_DUPLICATE_UNSUPPORTED');
}

const validDate = (date: string | null): date is string =>
  date !== null && /^\d{4}-\d{2}-\d{2}$/.test(date)
    && new Date(date).toJSON()?.slice(0, 10) === date;

export function duplicateCaptureInput(
  order: OrderProps, companyId: number, orderedAt: string, historicalDiscounts: CaptureOrderDiscounts,
): CaptureInput {
  const native = order.storage?.legacyId !== null && order.captureDetails === undefined;
  if ((order.companyId ?? (native ? undefined : 1)) !== companyId || companyId !== 1) {
    unsupported('Duplicar está disponible para pedidos y cotizaciones de México.');
  }
  if (order.documentKind === 'unknown' || order.lines.length > 500) {
    unsupported('El tipo de documento o la cantidad de partidas no admite duplicación.');
  }
  if ([order.totals.freight, order.totals.insurance, order.totals.other].some(amount => amount !== 0)) {
    unsupported('El pedido contiene cargos adicionales que el alta actual no admite.');
  }
  const allowedCurrencies = native ? [0, 1, 2] : [0, 1];
  if (!allowedCurrencies.includes(order.currencyId)) unsupported('La moneda del pedido no es compatible con el alta.');
  const collectionCurrency = order.captureDetails?.collectionCurrency ?? ((native ? order.currencyId === 2 : order.currencyId === 1) ? 'DOLARES' : 'PESOS');
  const currency: CaptureCurrencyId = collectionCurrency === 'PESOS' ? 1 : 2;
  const details = order.captureDetails;
  const orderDiscounts = details?.orderDiscounts ?? historicalDiscounts;
  if (orderDiscounts.some(value => !Number.isFinite(value) || value < 0 || value > 100)) {
    unsupported('Los descuentos del documento no son compatibles con el alta.');
  }
  const lines = order.lines.map<CaptureInput['lines'][number]>(line => {
    const price = line.sourcePrice ?? line.price;
    const currencyId = line.sourceCurrencyId ?? (native ? line.currencyId || currency : currency);
    if (!line.productCode?.trim() || !Number.isFinite(line.ordered) || line.ordered <= 0 || line.ordered > 999999
      || !Number.isFinite(price) || price < 0 || price > 999999999 || !Number.isFinite(line.discount)
      || line.discount < 0 || line.discount > 100 || (currencyId !== 1 && currencyId !== 2)) {
      unsupported(`La partida ${line.productCode || line.id} contiene datos incompatibles con el alta.`);
    }
    return { productCode: line.productCode.trim(), quantity: line.ordered, price, discount: line.discount, currencyId };
  });
  if (!(order.exchangeRate > 0) && (currency === 2 || lines.some(line => line.currencyId === 2))) {
    unsupported('El documento en dólares requiere un tipo de cambio válido.');
  }
  const { from, dueAt } = order.dates;
  const hasRange = validDate(from) && validDate(dueAt) && from <= dueAt;
  return {
    companyId, typeCode: 'P', documentKind: 'order', orderedAt,
    from: hasRange ? from : orderedAt, dueAt: hasRange ? dueAt : orderedAt,
    customerCode: order.customer.code, customerOrderNumber: '', warehouse: normalizeOrderWarehouse(order.warehouse),
    agentCode: order.classifications[0]?.trim() ?? '', store: order.classifications[2]?.trim() ?? '',
    termsDays: order.termsDays, branch: order.branch, department: order.department, initial: order.initial,
    observations: order.observations, exchangeRate: order.exchangeRate > 0 ? order.exchangeRate : 1,
    collectionCurrency, orderDiscounts, boxes: 0, commission: details?.commission ?? 0,
    noPartialDeliveries: details?.noPartialDeliveries ?? false, transportation: details?.transportation ?? '',
    deliveryAddress: details?.deliveryAddress ?? ['', '', ''], contact: details?.contact ?? '',
    additionalComments: details?.additionalComments ?? '', lines,
  };
}
