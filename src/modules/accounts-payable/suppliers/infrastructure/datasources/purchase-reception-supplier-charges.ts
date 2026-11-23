import {
  readLocalPurchaseReceptions, type LocalReceptionRecord,
} from '../../../../purchasing/purchase-receptions/infrastructure/datasources/postgres-purchase-reception-writes.js';

interface ReceiptSupplierBalance {
  supplierId: number;
  balance: number;
}

export async function purchaseReceptionSupplierBalances(supplierIds: number[]): Promise<Map<number, number>> {
  if (supplierIds.length === 0) return new Map();
  return readLocalPurchaseReceptions(new Map<number, number>(), async (client) => {
    // Derivada. Los cargos de recepciones web son saldos abiertos en la compañía del panel.
    const { rows } = await client.query<ReceiptSupplierBalance>(
      `SELECT (result #>> '{reception,supplier,id}')::bigint::float8 AS "supplierId",
              sum((payable->>'amount')::numeric)::float8 AS balance
       FROM tuvansa.purchase_receptions
       WHERE company_id = 1 AND payable IS NOT NULL
         AND (result #>> '{reception,supplier,id}')::bigint = ANY($1::bigint[])
       GROUP BY (result #>> '{reception,supplier,id}')::bigint`, [supplierIds],
    );
    return new Map(rows.map(({ supplierId, balance }) => [supplierId, balance]));
  });
}

export type SupplierPurchaseReceptionCharge = Pick<LocalReceptionRecord, 'result' | 'movement' | 'accounting'> & {
  payable: NonNullable<LocalReceptionRecord['payable']>;
  days: number;
};

export async function purchaseReceptionSupplierCharges(supplierId: number): Promise<SupplierPurchaseReceptionCharge[]> {
  return readLocalPurchaseReceptions<SupplierPurchaseReceptionCharge[]>([], async (client) => {
    // Derivada. Vincula la póliza y el cargo con la orden y recepción locales.
    const { rows } = await client.query<SupplierPurchaseReceptionCharge>(
      `SELECT result, movement, payable, accounting, CURRENT_DATE - (payable->>'dueAt')::date AS days
       FROM tuvansa.purchase_receptions
       WHERE company_id = 1 AND payable IS NOT NULL
         AND (result #>> '{reception,supplier,id}')::bigint = $1
       ORDER BY id`, [supplierId],
    );
    return rows;
  });
}
