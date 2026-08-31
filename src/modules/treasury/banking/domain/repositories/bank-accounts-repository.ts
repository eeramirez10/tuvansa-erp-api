import type { BankAccount } from '../entities/bank-account.js';

export type BankAccountNavigationDirection = 'previous' | 'next';

export interface BankAccountSearchCriteria {
  query?: string;
  code?: string;
  accountNumber?: string;
  name?: string;
  offset: number;
  limit: number;
}

export interface BankAccountSearchResult {
  items: BankAccount[];
  total: number;
}

export interface BankAccountsRepository {
  findById(bankAccountId: number): Promise<BankAccount | null>;
  findByCode(code: string): Promise<BankAccount | null>;
  findFirst(): Promise<BankAccount | null>;
  findAdjacent(bankAccountId: number, direction: BankAccountNavigationDirection): Promise<BankAccount | null>;
  search(criteria: BankAccountSearchCriteria): Promise<BankAccountSearchResult>;
}
