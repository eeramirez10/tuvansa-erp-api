import { NotFoundError } from '../../../../../shared/domain/errors/not-found-error.js';
import type { BankAccountsRepository } from '../../domain/repositories/bank-accounts-repository.js';
import { toBankAccountResponse } from '../dtos/bank-account-response.js';

export class GetBankAccount {
  constructor(private readonly repository: BankAccountsRepository) {}

  async execute(bankAccountId: number) {
    const account = await this.repository.findById(bankAccountId);
    if (account === null) throw new NotFoundError('Cuenta bancaria');
    return toBankAccountResponse(account);
  }
}
