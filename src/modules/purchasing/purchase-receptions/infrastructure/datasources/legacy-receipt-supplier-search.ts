import type { ReceiptSupplierChange } from './purchase-reception-supplier-change-reads.js';

/** Returns the effective FDOC supplier before native filters, sorting and pagination. */
export function legacyReceiptSupplierSearch(
  changes: ReceiptSupplierChange[], source = { document: 'FDOC', supplier: 'FPRV', supplierId: 'FDOC.PRVSEQ' },
) {
  const { document, supplier, supplierId } = source;
  const code = `${supplier}.PRVCOD`;
  const name = `${supplier}.PRVNOM`;
  if (!changes.length) return { join: '', values: [], id: supplierId, code, name };
  // La versión MySQL heredada necesita tipos explícitos para materializar un SELECT de un solo proveedor.
  const rows = [`SELECT CAST(? AS UNSIGNED) AS receipt_id, CAST(? AS CHAR CHARACTER SET utf8) AS receipt_number,
    CAST(? AS UNSIGNED) AS original_supplier_id, CAST(? AS UNSIGNED) AS supplier_id,
    CAST(? AS CHAR CHARACTER SET utf8) AS supplier_code, CAST(? AS CHAR CHARACTER SET utf8) AS supplier_name`,
    ...changes.slice(1).map(() => 'SELECT ?, ?, ?, ?, ?, ?')];
  return {
    join: `LEFT JOIN (${rows.join(' UNION ALL ')}) receipt_supplier
      ON receipt_supplier.receipt_id=${document}.DSEQ AND BINARY receipt_supplier.receipt_number=BINARY ${document}.DNUM
      AND receipt_supplier.original_supplier_id=${document}.PRVSEQ AND ${document}.DITIPMV='RA' AND ${document}.DMULTICIA=1`,
    values: changes.flatMap(({ receiptId, receiptNumber, originalSupplierId, supplier }) =>
      [receiptId, receiptNumber, originalSupplierId, supplier.id, supplier.code, supplier.name]),
    id: `CAST(COALESCE(receipt_supplier.supplier_id,${supplierId}) AS UNSIGNED)`,
    code: `COALESCE(CONVERT(receipt_supplier.supplier_code USING utf8),CONVERT(${code} USING utf8)) COLLATE utf8_bin`,
    name: `COALESCE(CONVERT(receipt_supplier.supplier_name USING utf8),CONVERT(${name} USING utf8)) COLLATE utf8_bin`,
  };
}
