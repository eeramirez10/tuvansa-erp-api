import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import { ConflictError } from '../../../../../shared/domain/errors/conflict-error.js';
import type { BankReconciliationInput, BankReconciliationMovement } from '../datasources/bank-reconciliation-data-source.js';

const mexicoDate = new Intl.DateTimeFormat('sv-SE', { dateStyle: 'short', timeZone: 'America/Mexico_City' });

export function bankCents(value: number) {
  const cents = Math.round(value * 100);
  if (!Number.isSafeInteger(cents) || cents / 100 !== value) {
    throw new ApplicationError('Captura un saldo con hasta dos decimales.', 'BANK_RECONCILIATION_INVALID_BALANCE', 422);
  }
  return cents;
}

export function validateReconciliationInput(input: BankReconciliationInput) {
  bankCents(input.expectedBankBalance);
  bankCents(input.statementBalance);
  if (input.movementIds.length === 0 || new Set(input.movementIds).size !== input.movementIds.length) {
    throw new ApplicationError('Selecciona movimientos distintos para conciliar.', 'BANK_RECONCILIATION_INVALID_SELECTION', 422);
  }
  if (input.statementDate > mexicoDate.format()) {
    throw new ApplicationError('La fecha del estado de cuenta no puede ser futura.', 'BANK_RECONCILIATION_INVALID_DATE', 422);
  }
}

export function reconcileMovements(
  input: BankReconciliationInput, movements: BankReconciliationMovement[], previousBankBalance: number, previousStatementDate: string | null,
) {
  const previous = bankCents(previousBankBalance);
  if (previous !== bankCents(input.expectedBankBalance)) {
    throw new ConflictError('El saldo del banco cambió. Actualiza la consulta y revisa la selección.', 'BANK_RECONCILIATION_STALE_BALANCE');
  }
  if ((previousStatementDate && input.statementDate < previousStatementDate)
      || movements.some(({ date }) => input.statementDate < date)) {
    throw new ApplicationError('Usa una fecha igual o posterior al último registro y a los movimientos seleccionados.',
      'BANK_RECONCILIATION_INVALID_DATE', 422);
  }
  const net = movements.reduce((sum, { amount }) => sum + bankCents(amount), 0);
  if (!Number.isSafeInteger(net) || !Number.isSafeInteger(previous + net)) {
    throw new ApplicationError('El saldo calculado excede el rango permitido.', 'BANK_RECONCILIATION_INVALID_BALANCE', 422);
  }
  if (previous + net !== bankCents(input.statementBalance)) {
    throw new ConflictError('El saldo del estado de cuenta debe coincidir con el saldo conciliado calculado.',
      'BANK_RECONCILIATION_STATEMENT_DIFFERENCE');
  }
  return { previousBankBalance, netMovement: net / 100, bankBalance: (previous + net) / 100 };
}
