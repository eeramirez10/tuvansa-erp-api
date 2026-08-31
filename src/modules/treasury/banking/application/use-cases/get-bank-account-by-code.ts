import { NotFoundError } from '../../../../../shared/domain/errors/not-found-error.js';
import type { BankAccountsRepository } from '../../domain/repositories/bank-accounts-repository.js';
import { toBankAccountResponse } from '../dtos/bank-account-response.js';

export class GetBankAccountByCode {
  constructor(private readonly repository: BankAccountsRepository) {}

  async execute(code: string) {
    const account = await this.repository.findByCode(code);
    if (account === null) throw new NotFoundError('Cuenta bancaria');
    return toBankAccountResponse(account);
  }
}
