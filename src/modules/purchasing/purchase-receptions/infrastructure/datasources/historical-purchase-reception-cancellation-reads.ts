import type { PostgresClient } from '../../../../../shared/infrastructure/database/postgres-pool.js';
import type { PostingReversalResult } from '../../domain/datasources/purchase-posting-reversal-data-source.js';
import { readPurchaseDocuments } from './postgres-purchase-payables.js';

export interface HistoricalReceiptCancellation {
  receiptId: number;
  supplierId: number;
  number: string;
  supplierReference: string;
  amount: number;
  result: PostingReversalResult;
  userId: number;
}

type HistoricalReceiptFilter = { receiptIds: number[] } | { supplierIds: number[] };

export async function historicalReceptionCancellationsOn(client: PostgresClient, filter: HistoricalReceiptFilter) {
  const receiptIds = 'receiptIds' in filter ? filter.receiptIds : undefined;
  const ids = receiptIds ?? ('supplierIds' in filter ? filter.supplierIds : []);
  if (!ids.length) return [];
  const { rows: [schema] } = await client.query<{ available: boolean }>(
    `SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='tuvansa'
      AND table_name='purchase_reception_cancellations' AND column_name='legacy_receipt_id') AS available`,
  );
  if (!schema?.available) return [];
  const field = receiptIds ? 'legacy_receipt_id' : "(historical_source->>'supplierId')::bigint";
  const { rows } = await client.query<HistoricalReceiptCancellation>(
    `SELECT legacy_receipt_id::float8 AS "receiptId",(historical_source->>'supplierId')::float8 AS "supplierId",
       historical_source->>'number' AS number,historical_source->>'supplierReference' AS "supplierReference",
       (historical_source->>'amount')::float8 AS amount,result,user_id AS "userId"
      FROM tuvansa.purchase_reception_cancellations WHERE company_id=1 AND legacy_receipt_id IS NOT NULL
        AND ${field}=ANY($1::bigint[]) ORDER BY date,id`,
    [ids],
  );
  return rows;
}

export function readHistoricalReceptionCancellations(filter: HistoricalReceiptFilter): Promise<HistoricalReceiptCancellation[]> {
  return readPurchaseDocuments<HistoricalReceiptCancellation[]>([], (client, tables) =>
    tables.receiptCancellations ? historicalReceptionCancellationsOn(client, filter) : Promise.resolve([]));
}
