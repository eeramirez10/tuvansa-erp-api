import type { PostgresClient } from '../../../../../shared/infrastructure/database/postgres-pool.js';
import { connectPostgres, postgresConfigured } from '../../../../../shared/infrastructure/database/postgres-pool.js';
import { migratePostgres } from '../../../../../shared/infrastructure/datasources/postgres-schema.js';
import type { ReceptionDocumentationPreview } from '../../domain/datasources/purchase-reception-documentation-data-source.js';
import { ensurePurchaseReceptionSchema } from './postgres-purchase-reception-writes.js';

const documentationIdStart = 8010000000000;
const documentIdStart = 8011000000000;
const seriesLength = 100000000;
export const isLocalReceptionDocumentationDocumentId = (id: number) => id >= documentIdStart && id < documentIdStart + seriesLength;

const migrations = [{ id: 'purchase_reception_documentations', sql: `
  CREATE SEQUENCE tuvansa.purchase_reception_documentation_ids
    START WITH ${documentationIdStart} MAXVALUE ${documentationIdStart + seriesLength - 1};
  CREATE SEQUENCE tuvansa.purchase_reception_documentation_document_ids
    START WITH ${documentIdStart} MAXVALUE ${documentIdStart + seriesLength - 1};
  CREATE TABLE tuvansa.purchase_reception_documentations (
    id bigint PRIMARY KEY,
    source_id bigint NOT NULL CHECK (source_id>0),
    local_receipt_id bigint REFERENCES tuvansa.purchase_receptions(id),
    source_number varchar(13) NOT NULL,
    company_id integer NOT NULL CHECK (company_id=1),
    supplier_id bigint NOT NULL CHECK (supplier_id>0),
    supplier_code text NOT NULL,
    supplier_name text NOT NULL,
    user_id integer NOT NULL CHECK (user_id>=0),
    request_key uuid NOT NULL,
    fingerprint char(64) NOT NULL,
    date date NOT NULL,
    due_date date,
    amount numeric(18,2) NOT NULL CHECK (amount>0),
    result jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK (local_receipt_id IS NULL OR local_receipt_id=source_id),
    UNIQUE(company_id,source_id),
    UNIQUE(company_id,request_key)
  );
  CREATE INDEX purchase_reception_documentations_supplier
    ON tuvansa.purchase_reception_documentations(company_id,supplier_id);
  CREATE TABLE tuvansa.purchase_reception_documentation_documents (
    id bigint PRIMARY KEY,
    documentation_id bigint NOT NULL REFERENCES tuvansa.purchase_reception_documentations(id),
    company_id integer NOT NULL CHECK (company_id=1),
    number varchar(13) NOT NULL CHECK (length(trim(number))>0),
    amount numeric(18,2) NOT NULL CHECK (amount>0),
    position smallint NOT NULL CHECK (position BETWEEN 1 AND 4),
    UNIQUE(documentation_id,position)
  );
  CREATE UNIQUE INDEX purchase_reception_documentation_document_number
    ON tuvansa.purchase_reception_documentation_documents(company_id,upper(number));
` }];

export async function ensurePurchaseReceptionDocumentationSchema(client: PostgresClient) {
  await ensurePurchaseReceptionSchema(client);
  await migratePostgres(client, migrations);
}

export async function purchaseReceptionDocumentationsAvailable(client: PostgresClient) {
  const { rows: [row] } = await client.query<{ present: boolean }>(
    "SELECT to_regclass('tuvansa.purchase_reception_documentations') IS NOT NULL AS present",
  );
  return row?.present === true;
}

export interface PurchaseReceptionDocumentationRecord {
  id: number;
  sourceId: number;
  sourceNumber: string;
  historical: boolean;
  supplierId: number;
  amount: number;
  date: string;
  userId: number;
  createdAt: string;
  result: ReceptionDocumentationPreview;
}

export async function purchaseReceptionDocumentationsOn(
  client: PostgresClient, scope: { sourceIds: number[] } | { supplierIds: number[] },
) {
  const bySource = 'sourceIds' in scope;
  const ids = bySource ? scope.sourceIds : scope.supplierIds;
  if (!ids.length || !await purchaseReceptionDocumentationsAvailable(client)) return [];
  const { rows } = await client.query<PurchaseReceptionDocumentationRecord>(
    `SELECT id::float8,source_id::float8 AS "sourceId",source_number AS "sourceNumber",
       local_receipt_id IS NULL AS historical,supplier_id::float8 AS "supplierId",
       amount::float8,date::text,user_id AS "userId",created_at::text AS "createdAt",result
     FROM tuvansa.purchase_reception_documentations
     WHERE company_id=1 AND ${bySource ? 'source_id' : 'supplier_id'}=ANY($1::bigint[]) ORDER BY id`, [ids],
  );
  return rows;
}

export async function readPurchaseReceptionDocumentations(scope: Parameters<typeof purchaseReceptionDocumentationsOn>[1]) {
  if (!postgresConfigured()) return [];
  const client = await connectPostgres();
  try { return await purchaseReceptionDocumentationsOn(client, scope); }
  finally { client.release(); }
}
