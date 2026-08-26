import type {
  ClientNavigationDirection,
  ClientToolbarRepository,
} from '../../domain/repositories/client-toolbar-repository.js';
import { NotFoundError } from '../../../../../shared/domain/errors/not-found-error.js';
import type { ClientsRepository } from '../../domain/repositories/clients-repository.js';
import { toClientResponse, type ClientResponse } from '../dtos/client-response.js';

export class NavigateClient {
  constructor(
    private readonly repository: ClientToolbarRepository,
    private readonly clientsRepository: ClientsRepository,
  ) {}

  async execute(
    clientId: number,
    direction: ClientNavigationDirection,
  ): Promise<ClientResponse | null> {
    if (await this.clientsRepository.findById(clientId) === null) {
      throw new NotFoundError('Cliente');
    }
    const client = await this.repository.findAdjacent(clientId, direction);
    return client === null ? null : toClientResponse(client);
  }
}
