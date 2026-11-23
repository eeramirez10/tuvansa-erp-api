import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import { ConflictError } from '../../../../../shared/domain/errors/conflict-error.js';
import type { SupplierPaymentInput, SupplierPaymentTarget } from '../datasources/supplier-payment-data-source.js';

export const paymentMoney = (amount: number) => Number(amount.toFixed(2));

export function supplierPaymentReason(target: SupplierPaymentTarget): string | null {
  if (target.cancelled) return 'La recepción está cancelada.';
  if (!target.receivedAt || target.principal <= 0 || target.currencyId !== 1 || target.exchangeRate !== 1) {
    return 'Sólo se admiten pagos de recepciones locales estándar en pesos.';
  }
  if (target.remaining <= 0) return 'La recepción no tiene saldo pendiente.';
  return null;
}

export function validateSupplierPayment(target: SupplierPaymentTarget, input: SupplierPaymentInput) {
  if (target.revision !== input.revision) {
    throw new ConflictError('El saldo de la recepción cambió. Vuelve a abrir el pago.', 'SUPPLIER_PAYMENT_REVISION_CHANGED');
  }
  const reason = supplierPaymentReason(target);
  if (reason) throw new ConflictError(reason, 'SUPPLIER_PAYMENT_UNAVAILABLE');
  const cents = Math.round(input.amount * 100);
  if (!Number.isSafeInteger(cents) || cents <= 0 || cents / 100 !== input.amount) {
    throw new ApplicationError('Captura un importe positivo con hasta dos decimales.', 'SUPPLIER_PAYMENT_AMOUNT_INVALID', 422);
  }
  if (input.amount > target.remaining) {
    throw new ConflictError('El importe del pago excede el saldo de la recepción.', 'SUPPLIER_PAYMENT_AMOUNT_EXCEEDS_BALANCE');
  }
  if (target.receivedAt && input.date < target.receivedAt.slice(0, 10)) {
    throw new ApplicationError('La fecha del pago debe ser igual o posterior a la fecha de recepción.', 'SUPPLIER_PAYMENT_DATE_INVALID', 422);
  }
}
