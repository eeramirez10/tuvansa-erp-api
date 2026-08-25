import { NotFoundError } from '../../../../../shared/domain/errors/not-found-error.js';
import type { ClientsRepository } from '../../domain/repositories/clients-repository.js';
import { toClientResponse, type ClientResponse } from '../dtos/client-response.js';

export class GetClient {
  constructor(private readonly clientsRepository: ClientsRepository) {}

  async execute(clientId: number): Promise<ClientResponse> {
    const client = await this.clientsRepository.findById(clientId);

    if (!client) {
      throw new NotFoundError('Cliente');
    }

    return toClientResponse(client);
  }
}
