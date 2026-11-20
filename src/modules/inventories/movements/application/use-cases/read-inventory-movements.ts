import { NotFoundError } from '../../../../../shared/domain/errors/not-found-error.js';
import type { MovementDocument, MovementHeader } from '../../domain/entities/inventory-movement.js';
import type { MovementFilters, MovementsRepository } from '../../domain/repositories/movements-repository.js';

type MovementList = {
  data: MovementHeader[];
  pagination: { page: number; pageSize: number; total: number };
};

type MovementDetail = MovementDocument & {
  cancellationAvailable: boolean;
  cancellationReason?: string;
};

export class ReadInventoryMovements {
  constructor(private readonly repository: MovementsRepository) {}

  async search(criteria: MovementFilters & { page: number; pageSize: number }): Promise<MovementList> {
    const { page, pageSize, ...filters } = criteria;
    const result = await this.repository.search({
      ...filters,
      offset: (page - 1) * pageSize,
      limit: pageSize,
    });
    return { data: result.items, pagination: { page, pageSize, total: result.total } };
  }

  async getById(id: number): Promise<{ data: MovementDetail }> {
    const found = await this.repository.findById(id);
    if (!found) throw new NotFoundError('Documento de inventario');
    return {
      data: {
        ...found,
        cancellationAvailable: false,
        cancellationReason: 'La cancelación todavía no está habilitada para este documento.',
      },
    };
  }
}
