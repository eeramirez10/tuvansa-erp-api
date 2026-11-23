import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import type { BankTransferInput } from '../datasources/bank-transfer-data-source.js';
import type { BankAccountProps } from './bank-account.js';
import { permitsBankPosting } from './bank-posting-role.js';

export const bankTransferAccount = ({ id, code, name }: BankAccountProps) => ({ id, code, name });

export function canTransfer(account: BankAccountProps, companyId: number, direction: 'source' | 'destination'): boolean {
  return companyId === 1 && permitsBankPosting(account, companyId, direction === 'source' ? 'payments' : 'deposits');
}

export function validateBankTransferInput(input: BankTransferInput, destinationAccountId: number) {
  if (input.sourceBankAccountId === destinationAccountId) {
    throw new ApplicationError('Elige dos cuentas bancarias distintas.', 'BANK_TRANSFER_SAME_ACCOUNT', 422);
  }
  const cents = Math.round(input.amount * 100);
  if (!Number.isSafeInteger(cents) || cents <= 0 || cents / 100 !== input.amount) {
    throw new ApplicationError('Captura un importe positivo con hasta dos decimales.', 'BANK_TRANSFER_INVALID_AMOUNT', 422);
  }
}
