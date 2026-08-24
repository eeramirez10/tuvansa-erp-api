import type {
  ClientSearchCriteria,
  ClientSearchResult,
  ClientsRepository,
} from '../../domain/repositories/clients-repository.js';
import type { Client } from '../../domain/entities/client.js';

/**
 * Adaptador de solo lectura para el origen legado.
 * Se implementara cuando confirmemos tablas, campos y mecanismo de conexion.
 */
export class ProscaiClientsRepository implements ClientsRepository {
  async findByCode(_clientCode: string): Promise<Client | null> {
    return Promise.resolve(null);
  }

  async search(_criteria: ClientSearchCriteria): Promise<ClientSearchResult> {
    return Promise.resolve({ items: [], total: 0 });
  }
}
