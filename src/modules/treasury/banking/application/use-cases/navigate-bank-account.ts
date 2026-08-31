import type {
  BankAccountNavigationDirection,
  BankAccountsRepository,
} from '../../domain/repositories/bank-accounts-repository.js';
import { toBankAccountResponse } from '../dtos/bank-account-response.js';

export class NavigateBankAccount {
  constructor(private readonly repository: BankAccountsRepository) {}

  async execute(bankAccountId: number, direction: BankAccountNavigationDirection) {
    const account = await this.repository.findAdjacent(bankAccountId, direction);
    return account === null ? null : toBankAccountResponse(account);
  }
}
