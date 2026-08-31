import type { BankAccountsDataSource } from '../../domain/datasources/bank-accounts-data-source.js';
import type { BankAccount } from '../../domain/entities/bank-account.js';
import type {
  BankAccountNavigationDirection,
  BankAccountSearchCriteria,
  BankAccountSearchResult,
  BankAccountsRepository,
} from '../../domain/repositories/bank-accounts-repository.js';

export class BankAccountsRepositoryImpl implements BankAccountsRepository {
  constructor(private readonly dataSource: BankAccountsDataSource) {}
  findById(id: number): Promise<BankAccount | null> { return this.dataSource.findById(id); }
  findByCode(code: string): Promise<BankAccount | null> { return this.dataSource.findByCode(code); }
  findFirst(): Promise<BankAccount | null> { return this.dataSource.findFirst(); }
  findAdjacent(id: number, direction: BankAccountNavigationDirection): Promise<BankAccount | null> {
    return this.dataSource.findAdjacent(id, direction);
  }
  search(criteria: BankAccountSearchCriteria): Promise<BankAccountSearchResult> {
    return this.dataSource.search(criteria);
  }
}
