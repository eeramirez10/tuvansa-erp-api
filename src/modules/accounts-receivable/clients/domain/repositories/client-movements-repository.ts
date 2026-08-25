import type { ClientMovement } from '../entities/client-movement.js';

export interface ClientMovementSearchCriteria {
  clientId: number;
  dateFrom?: string;
  dateTo?: string;
  limit: number;
  offset: number;
}

export interface ClientMovementsResult {
  client: {
    id: number;
    code: string;
    name: string;
    currentBalance: number;
  };
  summary: {
    openingBalance: number;
    charges: number;
    credits: number;
    netMovement: number;
    closingBalance: number;
    movementCount: number;
  };
  items: ClientMovement[];
}

export interface ClientMovementsRepository {
  searchByClient(criteria: ClientMovementSearchCriteria): Promise<ClientMovementsResult | null>;
}
