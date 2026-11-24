import { readSalesRemissions } from './postgres-sales-remissions.js';
import {
  historicalSalesRemissionCancellationsOn, type HistoricalSalesRemissionCancellation, type HistoricalSalesRemissionFilter,
} from './sales-remission-cancellation-reads.js';

export { historicalSalesRemissionCancellationsOn, type HistoricalSalesRemissionCancellation } from './sales-remission-cancellation-reads.js';

export function readHistoricalSalesRemissionCancellations(filter: HistoricalSalesRemissionFilter): Promise<HistoricalSalesRemissionCancellation[]> {
  return readSalesRemissions<HistoricalSalesRemissionCancellation[]>([], (client) => historicalSalesRemissionCancellationsOn(client, filter));
}
