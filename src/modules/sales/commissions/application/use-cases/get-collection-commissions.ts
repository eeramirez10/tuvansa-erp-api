import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import { buildCollectionCommissions, type CollectionCriteria } from '../../domain/entities/collection-commissions.js';
import type { CollectionCommissionsRepository } from '../../domain/repositories/collection-commissions-repository.js';
import type { SettlementSettings } from '../../domain/entities/collection-settlement.js';
const validDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && value >= '1901-01-01' && value <= '2100-12-31' &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
export class GetCollectionCommissions {
  constructor(private readonly repository: CollectionCommissionsRepository, private readonly clock = () => new Date()) {}
  async options() {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City', year: 'numeric', month: '2-digit', day: '2-digit' }).format(this.clock());
    return { ...await this.repository.options(), defaultFrom: today.slice(0, 8) + '01', defaultTo: today };
  }
  async execute(criteria: CollectionCriteria, settings?: SettlementSettings) {
    const options = await this.options(), branch = options.branches.find(b => b.code === criteria.branch);
    if (!validDate(criteria.from) || !validDate(criteria.to) || criteria.from > criteria.to ||
      Date.parse(criteria.to) - Date.parse(criteria.from) > 365 * 86_400_000 ||
      (criteria.branch !== 'all' && !branch) || (criteria.agent !== 'all' && !options.agents.some(a => a.code === criteria.agent)) ||
      settings?.agents.some(a => !options.agents.some(o => o.code === a.code))) {
      throw new ApplicationError('Selecciona fechas válidas (máximo 366 días), sucursal y agente disponibles.', 'COLLECTION_COMMISSIONS_INVALID', 400);
    }
    return buildCollectionCommissions(options, criteria, await this.repository.read(criteria, branch?.warehouses), this.clock().toISOString(), settings);
  }
}
