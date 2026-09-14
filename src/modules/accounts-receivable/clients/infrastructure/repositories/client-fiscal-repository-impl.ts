import type { ClientFiscalDataSource } from '../../domain/datasources/client-fiscal-data-source.js';
import type { SaveClientFiscal } from '../../domain/entities/client-fiscal.js';
import type { ClientFiscalRepository } from '../../domain/repositories/client-fiscal-repository.js';

export class ClientFiscalRepositoryImpl implements ClientFiscalRepository {
  constructor(private readonly source: ClientFiscalDataSource) {}
  find = (clientId: number) => this.source.find(clientId);
  save = (clientId: number, input: SaveClientFiscal) => this.source.save(clientId, input);
}
