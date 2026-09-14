import type { ClientFiscal, FiscalSaveResult, SaveClientFiscal } from '../entities/client-fiscal.js';

export interface ClientFiscalDataSource {
  find(clientId: number): Promise<ClientFiscal | null>;
  save(clientId: number, input: SaveClientFiscal): Promise<FiscalSaveResult>;
}
