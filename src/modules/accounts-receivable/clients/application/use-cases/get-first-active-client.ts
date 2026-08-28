import { NotFoundError } from '../../../../../shared/domain/errors/not-found-error.js';
import type { ClientsRepository } from '../../domain/repositories/clients-repository.js';
import { toClientResponse, type ClientResponse } from '../dtos/client-response.js';

export class GetFirstActiveClient {
  constructor(private readonly repository: ClientsRepository) {}

  async execute(): Promise<ClientResponse> {
    const client = await this.repository.findFirstActive();
    if (client === null) throw new NotFoundError('Cliente');
    return toClientResponse(client);
  }
}
