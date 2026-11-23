import { Client } from '../../domain/entities/client.js';
import type { ClientNavigationDirection } from '../../domain/repositories/client-toolbar-repository.js';
import type { ClientSearchCriteria } from '../../domain/repositories/clients-repository.js';
import {
  clientMoney, salesRemissionCustomerTotals, type SalesRemissionCustomerTotals,
} from './client-ledger-with-sales-remissions-data-source.js';
import { LegacyMysqlClientsDataSource } from './legacy-mysql-clients-data-source.js';

function withRemissions(client: Client, remissions: SalesRemissionCustomerTotals | undefined): Client {
  if (!remissions) return client;
  const props = client.toPrimitives();
  const currentBalance = clientMoney(props.totals.currentBalance + remissions.balance);
  const availableCredit = clientMoney(Math.max(props.terms.creditLimit - currentBalance, 0));
  const previousDate = props.totals.lastPurchaseAt;
  const receiptDate = remissions.lastPurchaseAt;
  const lastPurchaseAt = receiptDate && (!previousDate || receiptDate > previousDate) ? receiptDate : previousDate;
  return Client.create({ ...props, totals: { ...props.totals, currentBalance, availableCredit, lastPurchaseAt } });
}

export class ClientsWithSalesRemissionsDataSource extends LegacyMysqlClientsDataSource {
  private async includeRemissions(read: Promise<Client | null>): Promise<Client | null> {
    const client = await read;
    if (!client) return null;
    const { id } = client.toPrimitives();
    const remissions = await salesRemissionCustomerTotals([id]);
    return withRemissions(client, remissions.get(id));
  }

  override findById(id: number) { return this.includeRemissions(super.findById(id)); }
  override findFirstActive() { return this.includeRemissions(super.findFirstActive()); }
  override findAdjacent(id: number, direction: ClientNavigationDirection) {
    return this.includeRemissions(super.findAdjacent(id, direction));
  }

  override async search(criteria: ClientSearchCriteria) {
    const result = await super.search(criteria);
    const remissions = await salesRemissionCustomerTotals(result.items.map((client) => client.toPrimitives().id));
    return { ...result, items: result.items.map((client) => withRemissions(client, remissions.get(client.toPrimitives().id))) };
  }
}
