import type {
  SupplierBalanceGroupingDataSource, SupplierBalanceGroupingInput,
} from '../../domain/datasources/supplier-balance-grouping-data-source.js';
import { ConflictError } from '../../../../../shared/domain/errors/conflict-error.js';

export class GroupSupplierBalance {
  constructor(private readonly source: SupplierBalanceGroupingDataSource) {}

  execute(supplierId: number, input: SupplierBalanceGroupingInput) {
    const ids = new Set(input.sources.map(({ id }) => id));
    if (ids.size !== input.sources.length || ids.has(input.target.id) || !ids.size) {
      throw new ConflictError('Selecciona documentos de origen distintos del destino.', 'SUPPLIER_GROUPING_SELECTION');
    }
    return this.source.save(supplierId, { ...input, sources: [...input.sources].sort((a, b) => a.id - b.id) });
  }
}
