import type { BankAccount } from '../entities/bank-account.js';
import type {
  BankAccountNavigationDirection,
  BankAccountSearchCriteria,
  BankAccountSearchResult,
} from '../repositories/bank-accounts-repository.js';

export interface BankAccountsDataSource {
  findById(bankAccountId: number): Promise<BankAccount | null>;
  findByCode(code: string): Promise<BankAccount | null>;
  findFirst(): Promise<BankAccount | null>;
  findAdjacent(bankAccountId: number, direction: BankAccountNavigationDirection): Promise<BankAccount | null>;
  search(criteria: BankAccountSearchCriteria): Promise<BankAccountSearchResult>;
}
