import type { ClientActionsDataSource } from '../../domain/datasources/client-actions-data-source.js';
import type { ClientActionsRepository } from '../../domain/repositories/client-actions-repository.js';

export class ClientActionsRepositoryImpl implements ClientActionsRepository {
  constructor(private readonly dataSource: ClientActionsDataSource) {}

  findClassifications: ClientActionsRepository['findClassifications'] = (clientId) =>
    this.dataSource.findClassifications(clientId);
  findDestinations: ClientActionsRepository['findDestinations'] = (clientId) =>
    this.dataSource.findDestinations(clientId);
  findBlockStatus: ClientActionsRepository['findBlockStatus'] = (clientId) =>
    this.dataSource.findBlockStatus(clientId);
  findDiscounts: ClientActionsRepository['findDiscounts'] = (criteria) =>
    this.dataSource.findDiscounts(criteria);
  findEvents: ClientActionsRepository['findEvents'] = (criteria) =>
    this.dataSource.findEvents(criteria);
  findBranches: ClientActionsRepository['findBranches'] = (criteria) =>
    this.dataSource.findBranches(criteria);
  findPhoto: ClientActionsRepository['findPhoto'] = (clientId) =>
    this.dataSource.findPhoto(clientId);
  findContacts: ClientActionsRepository['findContacts'] = (criteria) =>
    this.dataSource.findContacts(criteria);
}
