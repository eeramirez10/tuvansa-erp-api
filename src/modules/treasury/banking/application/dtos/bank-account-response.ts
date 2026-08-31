import type { BankAccount, BankAccountProps } from '../../domain/entities/bank-account.js';

export type BankAccountResponse = BankAccountProps;
export const toBankAccountResponse = (account: BankAccount): BankAccountResponse => account.toPrimitives();
