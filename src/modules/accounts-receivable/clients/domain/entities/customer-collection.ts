import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import { ConflictError } from '../../../../../shared/domain/errors/conflict-error.js';
import type { CustomerCollectionInput, CustomerCollectionTarget } from '../datasources/customer-collection-data-source.js';

export function collectionReason(target: CustomerCollectionTarget): string | null {
  if (target.canceled) return 'La remisión está cancelada.';
  if (target.movementType !== 'FA' || target.principal <= 0 || target.currencyId !== 1 || target.exchangeRate !== 1) {
    return 'La cobranza está disponible para remisiones web activas en pesos.';
  }
  return target.remaining > 0 ? null : 'La remisión ya está liquidada.';
}

export function validateCustomerCollection(target: CustomerCollectionTarget, input: CustomerCollectionInput) {
  if (target.revision !== input.revision) {
    throw new ConflictError('El saldo de la remisión cambió. Vuelve a abrir el cobro.', 'CUSTOMER_COLLECTION_REVISION_CHANGED');
  }
  const reason = collectionReason(target);
  if (reason) throw new ConflictError(reason, 'CUSTOMER_COLLECTION_UNAVAILABLE');

  const cents = Math.round(input.amount * 100);
  if (!Number.isSafeInteger(cents) || cents <= 0 || cents / 100 !== input.amount) {
    throw new ApplicationError('Captura un importe positivo con hasta dos decimales.', 'CUSTOMER_COLLECTION_AMOUNT_INVALID', 422);
  }
  if (input.amount > target.remaining) {
    throw new ConflictError('El importe del cobro excede el saldo de la remisión.', 'CUSTOMER_COLLECTION_AMOUNT_EXCEEDS_BALANCE');
  }
  if (input.date < target.issuedAt) {
    throw new ApplicationError('La fecha de cobro debe ser igual o posterior a la remisión.', 'CUSTOMER_COLLECTION_DATE_INVALID', 422);
  }
}
