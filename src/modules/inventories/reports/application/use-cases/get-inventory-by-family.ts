import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import { buildInventoryByFamily, inventoryBranchCode, type InventoryCriteria } from '../../domain/entities/inventory-by-family.js';
import type { InventoryReportsRepository } from '../../domain/repositories/inventory-reports-repository.js';

export class GetInventoryByFamily {
  constructor(private readonly repository: InventoryReportsRepository, private readonly clock = () => new Date()) {}
  async options() {
    const options = await this.repository.options();
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City', year: 'numeric', month: '2-digit', day: '2-digit' }).format(this.clock());
    return { ...options, defaultDate: today };
  }
  async execute(criteria: InventoryCriteria) {
    criteria = { ...criteria, scope: criteria.scope ?? 'branch', includeUndated: criteria.includeUndated ?? false };
    const options = await this.options();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(criteria.asOf) || Number(criteria.asOf.slice(0, 4)) < 1901 || Number(criteria.asOf.slice(0, 4)) > 2100 ||
      !Number.isFinite(Date.parse(criteria.asOf)) || new Date(criteria.asOf).toISOString().slice(0, 10) !== criteria.asOf ||
      (criteria.warehouse !== 'all' && !options.warehouses.some(w => w.code === criteria.warehouse)) ||
      (criteria.scope === 'branch' && criteria.warehouse !== 'all' && inventoryBranchCode(options, criteria.warehouse) !== criteria.warehouse) ||
      (criteria.family !== 'all' && !options.families.some(f => f.code === criteria.family))) {
      throw new ApplicationError('Fecha, almacén o familia no disponible.', 'INVENTORY_REPORT_INVALID', 400);
    }
    return buildInventoryByFamily(options, criteria, await this.repository.balances(criteria), this.clock().toISOString());
  }
}
