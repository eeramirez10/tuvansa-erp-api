import type { Client, ClientProps } from '../../domain/entities/client.js';

export interface ClientResponse {
  id: number;
  code: string;
  name: string;
  isActive: boolean;
  deactivatedAt: string | null;
  address: ClientProps['address'];
  contact: ClientProps['contact'];
  fiscal: ClientProps['fiscal'];
  indicators: ClientProps['indicators'];
  terms: ClientProps['terms'];
  totals: ClientProps['totals'];
  createdAt: string | null;
}

export const toClientResponse = (client: Client): ClientResponse => client.toPrimitives();
