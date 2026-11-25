import {
  connectPostgres, postgresConfigured, type PostgresClient,
} from '../database/postgres-pool.js';

export interface SupplierGroupingMovement {
  id: number;
  receiptId: number;
  date: string;
  document: string;
  amount: number;
  paymentReference: string;
  relatedDocumentId: number;
}

export async function supplierGroupingMovementsOn(
  client: PostgresClient, scope: { supplierId: number } | { documentIds: number[] },
) {
  const { rows: [table] } = await client.query<{ present: boolean }>(
    "SELECT to_regclass('tuvansa.supplier_balance_grouping_transfers') IS NOT NULL AS present",
  );
  if (!table?.present) return [];
  const supplier = 'supplierId' in scope;
  const predicate = (column: string) => supplier ? 'g.supplier_id=$1' : `t.${column}=ANY($1::bigint[])`;
  const { rows } = await client.query<SupplierGroupingMovement>(
    `SELECT t.id::float8 AS id, t.target_id::float8 AS "receiptId", g.date::text, t.target_number AS document,
       t.amount::float8 AS amount, t.source_number AS "paymentReference", t.source_id::float8 AS "relatedDocumentId"
     FROM tuvansa.supplier_balance_grouping_transfers t JOIN tuvansa.supplier_balance_groupings g ON g.id=t.grouping_id
     WHERE ${predicate('target_id')}
     UNION ALL
     SELECT (t.id+1)::float8, t.source_id::float8, g.date::text, t.source_number,
       -t.amount::float8, t.target_number, t.target_id::float8
     FROM tuvansa.supplier_balance_grouping_transfers t JOIN tuvansa.supplier_balance_groupings g ON g.id=t.grouping_id
     WHERE ${predicate('source_id')} ORDER BY 1`, [supplier ? scope.supplierId : scope.documentIds],
  );
  return rows;
}

export async function readSupplierGroupingMovements(scope: Parameters<typeof supplierGroupingMovementsOn>[1]) {
  if (!postgresConfigured()) return [];
  const client = await connectPostgres();
  try { return await supplierGroupingMovementsOn(client, scope); }
  finally { client.release(); }
}

export async function hasSupplierBalanceGrouping(client: PostgresClient, documentId: number) {
  return (await supplierGroupingMovementsOn(client, { documentIds: [documentId] })).length > 0;
}

export const groupedSupplierBalanceReason = 'El saldo de la recepción cambió por una agrupación de documentos.';
