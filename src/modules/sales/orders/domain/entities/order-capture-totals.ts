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

export function captureMinimumPrice(product: CaptureProduct, priceCurrencyId: CaptureCurrencyId, exchangeRate: number) {
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

const small = ['CERO','UNO','DOS','TRES','CUATRO','CINCO','SEIS','SIETE','OCHO','NUEVE','DIEZ','ONCE','DOCE','TRECE','CATORCE','QUINCE','DIECISÉIS','DIECISIETE','DIECIOCHO','DIECINUEVE','VEINTE','VEINTIUNO','VEINTIDÓS','VEINTITRÉS','VEINTICUATRO','VEINTICINCO','VEINTISÉIS','VEINTISIETE','VEINTIOCHO','VEINTINUEVE'];
function integerWords(n: number): string {
  if (n < 30) return small[n]!;
  if (n < 100) return ['', '', '', 'TREINTA','CUARENTA','CINCUENTA','SESENTA','SETENTA','OCHENTA','NOVENTA'][Math.floor(n / 10)]! + (n % 10 ? ` Y ${integerWords(n % 10)}` : '');
  if (n === 100) return 'CIEN';
  if (n < 1000) return ['', 'CIENTO','DOSCIENTOS','TRESCIENTOS','CUATROCIENTOS','QUINIENTOS','SEISCIENTOS','SETECIENTOS','OCHOCIENTOS','NOVECIENTOS'][Math.floor(n / 100)]! + (n % 100 ? ` ${integerWords(n % 100)}` : '');
  const scale = n < 1_000_000 ? 1000 : 1_000_000;
  const group = Math.floor(n / scale);
  const prefix = group === 1 ? (scale === 1000 ? 'MIL' : 'UN MILLÓN') : `${integerWords(group).replace(/UNO$/, 'UN')} ${scale === 1000 ? 'MIL' : 'MILLONES'}`;
  return prefix + (n % scale ? ` ${integerWords(n % scale)}` : '');
}
export function amountInWords(total: number): string {
  const cents = Math.round(total * 100);
  return `${integerWords(Math.floor(cents / 100))} ${String(cents % 100).padStart(2, '0')}/100`;
}
