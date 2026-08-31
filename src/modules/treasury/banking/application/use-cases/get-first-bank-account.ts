import type { BankAccountsRepository } from '../../domain/repositories/bank-accounts-repository.js';
import { toBankAccountResponse } from '../dtos/bank-account-response.js';

export class GetFirstBankAccount {
  constructor(private readonly repository: BankAccountsRepository) {}

  async execute() {
    const account = await this.repository.findFirst();
    return account === null ? null : toBankAccountResponse(account);
  }
}
