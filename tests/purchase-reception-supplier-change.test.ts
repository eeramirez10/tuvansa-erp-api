import { PGlite } from '@electric-sql/pglite';
import { expect, it } from 'vitest';
import type { ReceiptSupplierChangeSource, ReceiptSupplierReplacement } from '../src/modules/purchasing/purchase-receptions/domain/datasources/purchase-reception-supplier-change-data-source.js';
import { PostgresPurchaseReceptionSupplierChanges } from '../src/modules/purchasing/purchase-receptions/infrastructure/datasources/postgres-purchase-reception-supplier-changes.js';
import { receiptSupplierChangesOn } from '../src/modules/purchasing/purchase-receptions/infrastructure/datasources/purchase-reception-supplier-change-reads.js';
import type { PostgresClient } from '../src/shared/infrastructure/database/postgres-pool.js';

it('cambia el proveedor de una RA íntegra y conserva la revisión al restaurar el original', async () => {
  const db = new PGlite();
  const client: PostgresClient = {
    async query<T extends object>(sql: string, values?: unknown[]) {
      if (values) return db.query<T>(sql, values);
      const results = await db.exec(sql);
      return { rows: (results.at(-1)?.rows ?? []) as T[] };
    },
    release() {},
  };
  const original = { id: 3523, code: '35341', name: 'Proveedor original' };
  const alternate = { id: 3536, code: '35436', name: 'Proveedor destino' };
  const source: ReceiptSupplierChangeSource = {
    reception: { id: 343646, number: 'RA09214' }, originalSupplier: original, supplierAccount: '2001001',
    amount: 1013.03, reason: null, version: 'native-1',
    historicalCharge: { id: 410300, date: '2025-02-08', dueAt: '2025-04-09', orderNumber: 'OA05036',
      supplierReference: 'REFERENCIA', policyNumber: '312502-0107', userId: 0 },
  };
  const candidates: ReceiptSupplierReplacement[] = [
    { ...original, eligible: true, account: '2001001' },
    { ...alternate, eligible: true, account: '2001001' },
    { id: 6, code: '000093', name: 'Otra cuenta', eligible: true, account: '2005002001' },
    { id: 7, code: '30000', name: 'USD', eligible: false, account: '2001001' },
  ];
  const store = new PostgresPurchaseReceptionSupplierChanges({
    enabled: async () => true,
    receipt: async (id) => id === 343646 ? source : id === 344959 ? {
      ...source, reception: { id, number: 'RA09260' }, reason: 'La recepción tiene pagos registrados.',
    } : null,
    suppliers: async ({ code = '' }, exact) => candidates.filter((supplier) => exact
      ? supplier.code === code : supplier.code.startsWith(code)),
  }, async () => client, () => true);
  try {
    const before = (await store.preview(1, 343646))!;
    expect(before).toMatchObject({ supplier: original, canWrite: true });
    expect(await store.search(1, 343646, { name: 'Proveedor' })).toEqual([alternate]);
    await expect(store.save(1, 343646, { supplierCode: '000093', revision: before.revision }))
      .rejects.toThrow('misma cuenta contable');
    await expect(store.save(1, 343646, { supplierCode: '30000', revision: before.revision }))
      .rejects.toThrow('configurado en pesos');
    const assigned = await store.save(1, 343646, { supplierCode: alternate.code, revision: before.revision });
    expect(assigned.supplier).toEqual(alternate);
    expect(assigned.revision).not.toBe(before.revision);
    await expect(store.save(1, 343646, { supplierCode: original.code, revision: before.revision }))
      .rejects.toThrow('La recepción cambió');
    const restored = await store.save(1, 343646, { supplierCode: original.code, revision: assigned.revision });
    expect(restored.supplier).toEqual(original);
    expect(restored.revision).not.toBe(before.revision);
    expect(await receiptSupplierChangesOn(client, { receiptIds: [343646] })).toMatchObject([{
      originalSupplierId: original.id, supplier: original, revision: 2, amount: 1013.03, supplierAccount: '2001001',
    }]);
    const paid = (await store.preview(1, 344959))!;
    expect(paid).toMatchObject({ canWrite: false });
    await expect(store.save(1, 344959, { supplierCode: alternate.code, revision: paid.revision })).rejects.toThrow('pagos registrados');
    await client.query(`CREATE TABLE tuvansa.purchase_expense_documents (
      id bigint,company_id int,number text,supplier_id bigint,supplier_code text,supplier_name text,amount numeric
    )`);
    await client.query("INSERT INTO tuvansa.purchase_expense_documents VALUES (7910000000000,1,'GAW00000001',3523,'35341','Proveedor original',10)");
    expect(await store.preview(1, 7910000000000)).toMatchObject({
      reception: { number: 'GAW00000001' }, supplier: original, canWrite: false, reason: expect.stringContaining('recepción ordinaria'),
    });
    expect(await store.preview(2, 343646)).toBeNull();
  } finally { await db.close(); }
}, 12_000);
