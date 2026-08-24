import type { Client } from '../../domain/entities/client.js';

export interface ClientResponse {
  code: string;
  name: string;
  legalName: string | null;
  taxId: string | null;
  isActive: boolean;
}

export const toClientResponse = (client: Client): ClientResponse => client.toPrimitives();
