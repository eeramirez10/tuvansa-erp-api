import type { CaptureCurrencyId, CaptureCurrencyName, CaptureLine, CaptureOrderDiscounts, CaptureProduct } from '../repositories/order-capture-repository.js';

export const roundAmount = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;
export const roundCapturePrice = (value: number) => Math.round((value + Number.EPSILON) * 100_000) / 100_000;
export const captureCurrencyId = (currency: CaptureCurrencyName): CaptureCurrencyId => currency === 'PESOS' ? 1 : 2;
export const captureCurrencyName = (currencyId: CaptureCurrencyId): CaptureCurrencyName => currencyId === 1 ? 'PESOS' : 'DOLARES';

// Derivada: el tipo de cambio representa pesos por dólar.
export function convertCaptureAmount(amount: number, from: CaptureCurrencyId, to: CaptureCurrencyId, exchangeRate: number) {
  if (from === to) return amount;
  return from === 2 ? amount * exchangeRate : amount / exchangeRate;
}

export function captureMinimumPrice(product: Pick<CaptureProduct, 'cost' | 'costCurrencyId'>, priceCurrencyId: CaptureCurrencyId, exchangeRate: number) {
  return convertCaptureAmount(product.cost, product.costCurrencyId, priceCurrencyId, exchangeRate);
}

// Derivada: cálculo equivalente para el caso capturado; la captura no contiene SUM().
export function captureTotals(
  lines: Array<{ input: CaptureLine; product: CaptureProduct }>,
  targetCurrencyId: CaptureCurrencyId = 1,
  exchangeRate = 1,
  orderDiscounts: CaptureOrderDiscounts = [0, 0, 0, 0],
) {
  let quantity = 0, subtotal = 0, discount = 0, tax = 0, excise = 0;
  for (const { input, product } of lines) {
    const sourceCurrencyId = input.currencyId ?? product.currencyId;
    const price = convertCaptureAmount(input.price, sourceCurrencyId, targetCurrencyId, exchangeRate);
    const gross = input.quantity * price;
    let taxable = gross * (1 - input.discount / 100);
    for (const percentage of orderDiscounts) taxable *= 1 - percentage / 100;
    quantity += input.quantity; subtotal += gross; discount += gross - taxable;
    tax += taxable * product.taxPercentage / 100;
    excise += taxable * product.excisePercentage / 100;
  }
  return { quantity: Math.round(quantity * 1000) / 1000, subtotal: roundAmount(subtotal), discount: roundAmount(discount),
    tax: roundAmount(tax), excise: roundAmount(excise),
    total: roundAmount(roundAmount(subtotal) - roundAmount(discount) + roundAmount(tax) + roundAmount(excise)) };
}

export { amountInWords } from '../../../../../shared/domain/format/amount-in-words.js';
