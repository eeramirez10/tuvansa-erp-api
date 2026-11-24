import {
  connectPostgres, postgresConfigured, type PostgresClient,
} from '../../../../../shared/infrastructure/database/postgres-pool.js';
import { migratePostgres } from '../../../../../shared/infrastructure/datasources/postgres-schema.js';
import type { ReceiptSupplierChange } from '../../domain/datasources/purchase-reception-supplier-change-data-source.js';
import type { PurchaseReceptionProps } from '../../domain/entities/purchase-reception.js';

export type { ReceiptSupplierChange } from '../../domain/datasources/purchase-reception-supplier-change-data-source.js';

const supplierChangeMigration = [{
  id: 'purchase_reception_supplier_changes',
  sql: `
    CREATE TABLE tuvansa.purchase_reception_supplier_changes (
      company_id integer NOT NULL CHECK(company_id=1),
      receipt_id bigint NOT NULL CHECK(receipt_id>0),
      receipt_number varchar(15) NOT NULL,
      original_supplier_id bigint NOT NULL CHECK(original_supplier_id>0),
      supplier_id bigint NOT NULL CHECK(supplier_id>0),
      supplier_code varchar(6) NOT NULL,
      supplier_name text NOT NULL,
      supplier_account text NOT NULL CHECK(supplier_account<>''),
      amount numeric(18,2) NOT NULL CHECK(amount>0),
      historical boolean NOT NULL,
      charge jsonb,
      revision integer NOT NULL CHECK(revision>0),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY(company_id,receipt_id),
      CHECK((historical AND charge IS NOT NULL AND jsonb_typeof(charge)='object') OR (NOT historical AND charge IS NULL))
    );
    CREATE INDEX purchase_reception_supplier_current ON tuvansa.purchase_reception_supplier_changes(company_id,supplier_id);
    CREATE INDEX purchase_reception_supplier_original ON tuvansa.purchase_reception_supplier_changes(company_id,original_supplier_id);
  `,
}];

export function ensureReceiptSupplierChangesSchema(client: PostgresClient) {
  return migratePostgres(client, supplierChangeMigration);
}

export async function receiptSupplierChangesAvailable(client: PostgresClient) {
  const { rows: [table] } = await client.query<{ present: boolean }>(
    "SELECT to_regclass('tuvansa.purchase_reception_supplier_changes') IS NOT NULL AS present",
  );
  return table?.present === true;
}

type ChangeScope = { receiptIds: number[] } | { supplierIds: number[] } | { historical: true };

export async function receiptSupplierChangesOn(client: PostgresClient, scope: ChangeScope): Promise<ReceiptSupplierChange[]> {
  const ids = 'receiptIds' in scope ? scope.receiptIds : 'supplierIds' in scope ? scope.supplierIds : undefined;
  if (ids?.length === 0 || !await receiptSupplierChangesAvailable(client)) return [];
  const condition = 'receiptIds' in scope ? 'receipt_id=ANY($1::bigint[])' : 'supplierIds' in scope
    ? '(supplier_id=ANY($1::bigint[]) OR original_supplier_id=ANY($1::bigint[]))' : 'historical';
  const { rows } = await client.query<ReceiptSupplierChange>(
    `SELECT receipt_id::float8 AS "receiptId",receipt_number AS "receiptNumber",
       original_supplier_id::float8 AS "originalSupplierId",
       jsonb_build_object('id',supplier_id,'code',supplier_code,'name',supplier_name) AS supplier,
       supplier_account AS "supplierAccount",amount::float8,historical,charge,revision
     FROM tuvansa.purchase_reception_supplier_changes WHERE company_id=1 AND ${condition} ORDER BY receipt_id`,
    ids ? [ids] : [],
  );
  return rows;
}

export async function readReceiptSupplierChanges(scope: ChangeScope) {
  if (!postgresConfigured()) return [];
  const client = await connectPostgres();
  try { return await receiptSupplierChangesOn(client, scope); }
  finally { client.release(); }
}

export function matchesReceiptSupplierChange(change: ReceiptSupplierChange | undefined, receipt: {
  id: number; number: string; supplier: { id: number };
}): change is ReceiptSupplierChange {
  return change?.receiptId === receipt.id && change.receiptNumber === receipt.number
    && change.originalSupplierId === receipt.supplier.id;
}

export async function withReceiptSupplierChange(receipt: PurchaseReceptionProps): Promise<PurchaseReceptionProps> {
  const [change] = await readReceiptSupplierChanges({ receiptIds: [receipt.id] });
  if (!matchesReceiptSupplierChange(change, receipt)) return receipt;
  return { ...receipt, supplier: change.supplier };
}
