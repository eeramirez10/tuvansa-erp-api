import type {
  ClientActionIdentity,
  ClientBlockStatus,
  ClientBranch,
  ClientClassificationOption,
  ClientClassificationValue,
  ClientContact,
  ClientDiscount,
  ClientEvent,
  UnresolvedClientAction,
} from '../entities/client-action.js';

export interface ClientActionCriteria {
  clientId: number;
  limit: number;
  offset: number;
}

export interface ClientActionResult<T extends object> {
  client: ClientActionIdentity;
  payload: T;
  total?: number;
}

export interface ClientActionsRepository {
  findClassifications(clientId: number): Promise<ClientActionResult<{
    classifications: ClientClassificationValue[];
    availableAgentOptions: ClientClassificationOption[];
  }> | null>;
  findDestinations(clientId: number): Promise<ClientActionResult<{
    destinations: UnresolvedClientAction;
  }> | null>;
  findBlockStatus(clientId: number): Promise<ClientActionResult<{
    blockStatus: ClientBlockStatus;
  }> | null>;
  findDiscounts(criteria: ClientActionCriteria): Promise<ClientActionResult<{
    discounts: ClientDiscount[];
  }> | null>;
  findEvents(criteria: ClientActionCriteria): Promise<ClientActionResult<{
    events: ClientEvent[];
  }> | null>;
  findBranches(criteria: ClientActionCriteria): Promise<ClientActionResult<{
    branches: ClientBranch[];
  }> | null>;
  findPhoto(clientId: number): Promise<ClientActionResult<{
    photo: UnresolvedClientAction;
  }> | null>;
  findContacts(criteria: ClientActionCriteria): Promise<ClientActionResult<{
    contacts: ClientContact[];
  }> | null>;
}
