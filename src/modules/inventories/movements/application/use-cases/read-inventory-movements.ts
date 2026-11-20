import { NotFoundError } from '../../../../../shared/domain/errors/not-found-error.js';
import type { MovementDocument, MovementHeader } from '../../domain/entities/inventory-movement.js';
import type { MovementFilters, MovementsRepository } from '../../domain/repositories/movements-repository.js';
import type { MovementCancellationRepository } from '../../domain/repositories/movement-cancellation-repository.js';

type MovementList = {
  data: MovementHeader[];
  pagination: { page: number; pageSize: number; total: number };
};

type MovementDetail = MovementDocument & {
  totals: MovementDocument['totals'] & { entries: number; exits: number };
  cancellationAvailable: boolean;
  cancellationReason?: string;
};

export class ReadInventoryMovements {
  constructor(
    private readonly repository: MovementsRepository,
    private readonly cancellations?: MovementCancellationRepository,
  ) {}

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
    const alreadyCancelled = found.lines.length > 0 && found.lines.every(({ type }) => type === 'K');
    let reason: string | null = 'La cancelación requiere una copia conciliada de movimientos en PostgreSQL.';
    if (alreadyCancelled) {
      reason = 'El movimiento ya está anulado.';
    } else if (this.cancellations) {
      reason = await this.cancellations.canCancel(found);
    }
    const { entries, exits } = found.lines.reduce((amounts, line) => ({
      entries: amounts.entries + Math.max(line.quantity, 0),
      exits: amounts.exits + Math.max(-line.quantity, 0),
    }), { entries: 0, exits: 0 });
    return {
      data: {
        ...found,
        totals: { ...found.totals, entries, exits },
        cancellationAvailable: reason === null,
        ...(reason === null ? {} : { cancellationReason: reason }),
      },
    };
  }
}
