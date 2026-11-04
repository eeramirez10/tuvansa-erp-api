import type { SalesBalance, SalesCriteria, SalesOptions } from '../entities/sales-by-family.js';
export interface SalesReportsRepository {
  options(): Promise<SalesOptions>;
  balances(criteria: SalesCriteria, companyId?: number): Promise<SalesBalance[]>;
}
