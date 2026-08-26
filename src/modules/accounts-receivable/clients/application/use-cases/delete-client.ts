import { ConflictError } from '../../../../../shared/domain/errors/conflict-error.js';
import { NotFoundError } from '../../../../../shared/domain/errors/not-found-error.js';
import type { ClientToolbarRepository } from '../../domain/repositories/client-toolbar-repository.js';

export class DeleteClient {
  constructor(private readonly repository: ClientToolbarRepository) {}

  async execute(clientId: number): Promise<void> {
    const result = await this.repository.delete(clientId);
    if (result.status === 'not-found') throw new NotFoundError('Cliente');
    if (result.status === 'in-use') {
      throw new ConflictError(
        `El cliente tiene registros relacionados en ${result.relation}`,
        'CLIENT_IN_USE',
      );
    }
  }
}
