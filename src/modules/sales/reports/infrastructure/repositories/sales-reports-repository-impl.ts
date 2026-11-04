import type { SalesReportsDataSource } from '../../domain/datasources/sales-reports-data-source.js';
import type { SalesReportsRepository } from '../../domain/repositories/sales-reports-repository.js';
import type { SalesCriteria } from '../../domain/entities/sales-by-family.js';
export class SalesReportsRepositoryImpl implements SalesReportsRepository {
  constructor(private readonly source: SalesReportsDataSource) {}
  options() { return this.source.options(); }
  balances(criteria: SalesCriteria, companyId?: number) { return this.source.balances(criteria, companyId); }
}
