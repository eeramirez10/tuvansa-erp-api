import { NotFoundError } from '../../../../../shared/domain/errors/not-found-error.js';
import type { ClientMovementsRepository } from '../../domain/repositories/client-movements-repository.js';
import {
  toClientMovementResponse,
  type ClientMovementResponse,
} from '../dtos/client-movement-response.js';

export interface GetClientMovementsInput {
  clientId: number;
  dateFrom?: string;
  dateTo?: string;
  page: number;
  pageSize: number;
}

export interface GetClientMovementsOutput {
  data: {
    client: {
      id: number;
      code: string;
      name: string;
      currentBalance: number;
    };
    summary: {
      openingBalance: number;
      charges: number;
      credits: number;
      netMovement: number;
      closingBalance: number;
      movementCount: number;
    };
    movements: ClientMovementResponse[];
  };
  pagination: {
    page: number;
    pageSize: number;
    total: number;
  };
}

export class GetClientMovements {
  constructor(private readonly movementsRepository: ClientMovementsRepository) {}

  async execute(input: GetClientMovementsInput): Promise<GetClientMovementsOutput> {
    const result = await this.movementsRepository.searchByClient({
      clientId: input.clientId,
      ...(input.dateFrom === undefined ? {} : { dateFrom: input.dateFrom }),
      ...(input.dateTo === undefined ? {} : { dateTo: input.dateTo }),
      limit: input.pageSize,
      offset: (input.page - 1) * input.pageSize,
    });

    if (result === null) {
      throw new NotFoundError('Cliente');
    }

    return {
      data: {
        client: result.client,
        summary: result.summary,
        movements: result.items.map(toClientMovementResponse),
      },
      pagination: {
        page: input.page,
        pageSize: input.pageSize,
        total: result.summary.movementCount,
      },
    };
  }
}
