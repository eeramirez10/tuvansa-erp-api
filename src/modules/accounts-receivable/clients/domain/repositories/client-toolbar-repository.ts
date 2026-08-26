import type { Client } from '../entities/client.js';

export type ClientNavigationDirection = 'previous' | 'next';

export interface ClientWriteValues {
  code?: string;
  name?: string;
  street?: string;
  exteriorNumber?: string;
  interiorNumber?: string;
  neighborhood?: string;
  borough?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  countryCode?: string;
  contactName?: string;
  phones?: string;
  fax?: string;
  email?: string;
  website?: string;
  taxId?: string;
  curp?: string;
  branch?: string;
  accountingAccount?: string;
  priceList?: number;
  discount1?: number;
  discount2?: number;
  discount3?: number;
  paymentTermDays?: number;
  creditLimit?: number;
  creditExpiresAt?: string | null;
  reviewDay?: string;
  reviewTime?: string;
  paymentDay?: string;
  paymentTime?: string;
  applyToClientCode?: string;
  reviewStartsFromInvoice?: boolean;
}

export interface ClientCreateValues extends ClientWriteValues {
  code: string;
  name: string;
}

export type DeleteClientResult =
  | { status: 'deleted' }
  | { status: 'not-found' }
  | { status: 'in-use'; relation: string };

export interface ClientToolbarRepository {
  findAdjacent(clientId: number, direction: ClientNavigationDirection): Promise<Client | null>;
  codeExists(code: string, excludingClientId?: number): Promise<boolean>;
  accountingAccountExists(account: string): Promise<boolean>;
  create(values: ClientCreateValues): Promise<Client>;
  update(clientId: number, values: ClientWriteValues): Promise<Client | null>;
  delete(clientId: number): Promise<DeleteClientResult>;
}
