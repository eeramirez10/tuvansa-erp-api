import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import { buildSalesByFamily, type SalesCriteria } from '../../domain/entities/sales-by-family.js';
import type { SalesReportsRepository } from '../../domain/repositories/sales-reports-repository.js';
const validDate = (date: string) => /^\d{4}-\d{2}-\d{2}$/.test(date) && date >= '1901-01-01' && date <= '2100-12-31' &&
  Number.isFinite(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date;
export class GetSalesByFamily {
  constructor(private readonly repository: SalesReportsRepository, private readonly clock = () => new Date()) {}
  async options() {
    const options = await this.repository.options();
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City', year: 'numeric', month: '2-digit', day: '2-digit' }).format(this.clock());
    return { ...options, defaultFrom: today.slice(0, 4) + '-01-01', defaultTo: today };
  }
  async execute(criteria: SalesCriteria) {
    const options = await this.options();
    const branch = options.branches.find(b => b.code === criteria.branch);
    if (!validDate(criteria.from) || !validDate(criteria.to) || criteria.from > criteria.to ||
      (criteria.branch !== 'all' && !branch) || (criteria.family !== 'all' && !options.families.some(f => f.code === criteria.family))) {
      throw new ApplicationError('Rango de fechas, sucursal o familia no disponible.', 'SALES_REPORT_INVALID', 400);
    }
    return buildSalesByFamily(options, criteria, await this.repository.balances(criteria, branch?.companyId), this.clock().toISOString());
  }
}
