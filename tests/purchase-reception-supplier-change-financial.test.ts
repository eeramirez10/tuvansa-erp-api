import { PGlite } from '@electric-sql/pglite';
import { expect, it, vi } from 'vitest';
import { LegacyMysqlSupplierPanelsDataSource } from '../src/modules/accounts-payable/suppliers/infrastructure/datasources/legacy-mysql-supplier-panels-data-source.js';
import { PostgresSupplierPayments } from '../src/modules/accounts-payable/suppliers/infrastructure/datasources/postgres-supplier-payments.js';
import { purchaseReceptionSupplierBalances } from '../src/modules/accounts-payable/suppliers/infrastructure/datasources/purchase-reception-supplier-charges.js';
import { SupplierPanelsWithPurchaseReceptionsDataSource } from '../src/modules/accounts-payable/suppliers/infrastructure/datasources/supplier-panels-with-purchase-receptions-data-source.js';
import { ManagePurchaseReceptionDocumentation } from '../src/modules/purchasing/purchase-receptions/application/use-cases/manage-purchase-reception-documentation.js';
import { PostgresPurchaseReceptionDocumentations } from '../src/modules/purchasing/purchase-receptions/infrastructure/datasources/postgres-purchase-reception-documentations.js';
import { ensurePurchaseReceptionSchema } from '../src/modules/purchasing/purchase-receptions/infrastructure/datasources/postgres-purchase-reception-writes.js';
import { ensureReceiptSupplierChangesSchema } from '../src/modules/purchasing/purchase-receptions/infrastructure/datasources/purchase-reception-supplier-change-reads.js';
import * as postgres from '../src/shared/infrastructure/database/postgres-pool.js';

it('reassigns payable projections for RA and RW and keeps Documenta tied to the effective liability', async () => {
  const db = new PGlite();
  const client: postgres.PostgresClient = {
    async query<T extends object>(sql: string, values?: unknown[]) {
      if (values) return db.query<T>(sql, values);
      const results = await db.exec(sql);
      return { rows: (results.at(-1)?.rows ?? []) as T[] };
    },
    release() {},
  };
  const connect = async () => client;
  const configured = () => true;
  const connectMock = vi.spyOn(postgres, 'connectPostgres').mockImplementation(connect);
  const configuredMock = vi.spyOn(postgres, 'postgresConfigured').mockImplementation(configured);
  const original = { id: 3523, code: '35341', name: 'Proveedor original' };
  const supplier = { id: 198, code: '30000', name: 'Proveedor destino' };
  const historical = { id: 343646, number: 'RA09214', amount: 1013.03, supplier: original,
    date: '2025-02-08', dueAt: '2025-04-09', reason: null, version: 'original', nativeRecord: null };
  const local = { id: 6700000000000, number: 'RW00000001', amount: 116 };
  const legacyPanel = vi.spyOn(LegacyMysqlSupplierPanelsDataSource.prototype, 'findPanel').mockImplementation(async (id, key) => ({
    supplier: { ...(id === original.id ? original : supplier), currentBalance: id === original.id ? historical.amount : 0 },
    items: id !== original.id ? [] : key === 'balance'
      ? [{ id: historical.id, document: historical.number, amount: historical.amount, originalAmount: historical.amount }]
      : [{ id: 574067, receiptId: historical.id, document: historical.number, amount: historical.amount, movementType: 'RA' }],
    ...(key === 'balance' ? { summary: { amount: id === original.id ? historical.amount : 0, originalAmount: id === original.id ? historical.amount : 0 } } : {}),
  }));
  try {
    await ensurePurchaseReceptionSchema(client);
    await ensureReceiptSupplierChangesSchema(client);
    const storage = new PostgresPurchaseReceptionDocumentations({
      enabled: async () => true, numberExists: async () => false,
      reception: async (id) => id === historical.id ? historical : null,
    }, connect, configured);
    const documents = new ManagePurchaseReceptionDocumentation(storage);
    const before = await documents.preview(1, historical.id);

    await client.query(
      `INSERT INTO tuvansa.purchase_receptions
        (id,number,company_id,user_id,request_key,fingerprint,order_id,order_number,order_revision,result,movement,order_line_effects,payable)
       VALUES ($1,$2,1,0,'a44dab49-3df3-4630-a621-c2110f065ca6',repeat('a',64),1,'OCW00000001',1,
         $3::jsonb,'{"header":{"type":"RA"}}','[]',$4::jsonb)`,
      [local.id, local.number, JSON.stringify({ reception: { supplier: original, dates: { receivedAt: historical.date }, totals: { balance: local.amount } } }),
        JSON.stringify({ amount: local.amount, currencyId: 1, exchangeRate: 1, dueAt: historical.dueAt })],
    );
    const charge = { id: 574067, date: historical.date, dueAt: historical.dueAt,
      supplierReference: 'ENTREGA', orderNumber: 'OA05036', policyNumber: '312502-0107', userId: 0 };
    for (const item of [{ ...historical, charge }, { ...local, charge: null }]) {
      await client.query(
        `INSERT INTO tuvansa.purchase_reception_supplier_changes
          (company_id,receipt_id,receipt_number,original_supplier_id,supplier_id,supplier_code,supplier_name,supplier_account,amount,historical,charge,revision)
         VALUES (1,$1,$2,$3,$4,$5,$6,'2001001',$7,$8,$9::jsonb,1)`,
        [item.id, item.number, original.id, supplier.id, supplier.code, supplier.name, item.amount, item.charge !== null,
          item.charge ? JSON.stringify(item.charge) : null],
      );
    }

    const payments = new PostgresSupplierPayments(connect, configured);
    const identity = { companyId: 1, supplierId: supplier.id, receiptId: local.id };
    expect(await payments.target({ ...identity, supplierId: original.id })).toBeNull();
    expect(await payments.target(identity)).toMatchObject({ remaining: 116, liability: { code: '2001001' } });
    expect(await payments.target({ ...identity, receiptId: historical.id })).toBeNull();

    const panels = new SupplierPanelsWithPurchaseReceptionsDataSource();
    expect(await panels.findPanel(original.id, 'balance')).toMatchObject({ supplier: { currentBalance: 0 }, items: [], summary: { amount: 0 } });
    expect(await panels.findPanel(original.id, 'movements')).toMatchObject({ items: [] });
    expect(await panels.findPanel(supplier.id, 'balance')).toMatchObject({
      supplier: { currentBalance: 1129.03 }, summary: { amount: 1129.03 },
      items: [{ id: historical.id, amount: 1013.03, canPay: false }, { id: local.id, amount: 116, canPay: true }],
    });
    expect(await panels.findPanel(supplier.id, 'movements')).toMatchObject({
      items: [{ id: local.id, amount: 116 }, { id: 574067, receiptId: historical.id, amount: 1013.03 }],
    });
    const balances = await purchaseReceptionSupplierBalances([original.id, supplier.id]);
    expect(balances.get(original.id)).toBe(-1013.03);
    expect(balances.get(supplier.id)).toBe(1129.03);

    await client.query(
      `UPDATE tuvansa.purchase_reception_supplier_changes
       SET supplier_id=$2,supplier_code=$3,supplier_name=$4,revision=revision+1 WHERE receipt_id=$1`,
      [historical.id, original.id, original.code, original.name],
    );
    expect(await panels.findPanel(original.id, 'balance')).toMatchObject({
      supplier: { currentBalance: 1013.03 }, items: [{ id: historical.id, amount: 1013.03 }],
    });
    expect(await panels.findPanel(supplier.id, 'balance')).toMatchObject({
      supplier: { currentBalance: 116 }, items: [{ id: local.id, amount: 116 }],
    });
    await client.query(
      `UPDATE tuvansa.purchase_reception_supplier_changes
       SET supplier_id=$2,supplier_code=$3,supplier_name=$4,revision=revision+1 WHERE receipt_id=$1`,
      [historical.id, supplier.id, supplier.code, supplier.name],
    );

    const input = {
      requestKey: 'f455eeda-7503-4145-abeb-4994e61626db',
      documents: [{ number: 'DocCambiaPrv', amount: historical.amount }],
    };
    const actor = { companyId: 1, userId: 0 };
    await expect(documents.save(actor, historical.id, { ...input, revision: before.revision })).rejects
      .toMatchObject({ code: 'PURCHASE_RECEPTION_DOCUMENTATION_STALE' });
    const saved = await documents.save(actor, historical.id, {
      ...input, revision: (await documents.preview(1, historical.id)).revision,
    });
    const [child] = saved.documents;
    expect(await payments.target({ ...identity, receiptId: child!.id })).toMatchObject({
      remaining: historical.amount, liability: { code: '2001001' },
    });
    expect(await panels.findPanel(supplier.id, 'balance')).toMatchObject({
      supplier: { currentBalance: 1129.03 }, summary: { amount: 1129.03 },
      items: [{ id: local.id, amount: 116 }, { id: child!.id, amount: 1013.03, canPay: true }],
    });
    expect((await panels.findPanel(supplier.id, 'movements'))?.items
      .filter(({ movementType }) => movementType === 'DO').map(({ amount }) => amount)).toEqual([-1013.03, 1013.03]);

    const cancelledId = 345931;
    const cancellationId = 7940000000000;
    const cancellationDate = '2025-04-10';
    const cancellationPolicy = '3KR00000001';
    await client.query(
      `INSERT INTO tuvansa.purchase_reception_supplier_changes
        (company_id,receipt_id,receipt_number,original_supplier_id,supplier_id,supplier_code,supplier_name,supplier_account,amount,historical,charge,revision)
       VALUES (1,$1,'RA09289',$2,$3,$4,$5,'2001001',1786.59,true,$6::jsonb,1)`,
      [cancelledId, original.id, supplier.id, supplier.code, supplier.name, JSON.stringify({ ...charge, id: 577806 })],
    );
    await client.query(`CREATE TABLE tuvansa.purchase_reception_cancellations (
      id bigint,receipt_id bigint,legacy_receipt_id bigint,company_id integer,policy_number text,date date,
      reason text,user_id integer,created_at timestamptz DEFAULT now(),result jsonb,historical_source jsonb
    )`);
    await client.query(
      `INSERT INTO tuvansa.purchase_reception_cancellations
        (id,legacy_receipt_id,company_id,policy_number,date,reason,user_id,result,historical_source)
       VALUES ($1,$2,1,$3,$4,'PRUEBA',0,$5::jsonb,$6::jsonb)`,
      [cancellationId, cancelledId, cancellationPolicy, cancellationDate,
        JSON.stringify({ id: cancellationId, policyNumber: cancellationPolicy, date: cancellationDate, reason: 'PRUEBA' }),
        JSON.stringify({ supplierId: supplier.id, originalSupplierId: original.id, number: 'RA09289', amount: 1786.59 })],
    );
    expect((await purchaseReceptionSupplierBalances([supplier.id])).get(supplier.id)).toBe(1129.03);
    expect(await panels.findPanel(supplier.id, 'balance')).toMatchObject({
      supplier: { currentBalance: 1129.03 }, items: [{ id: local.id, amount: 116 }, { id: child!.id, amount: 1013.03 }],
    });
    expect((await panels.findPanel(supplier.id, 'movements'))?.items
      .filter(({ document }) => document === 'RA09289').map(({ movementType, amount }) => [movementType, amount]))
      .toEqual([['RA', 1786.59], ['K', -1786.59]]);
  } finally {
    legacyPanel.mockRestore();
    configuredMock.mockRestore();
    connectMock.mockRestore();
    await db.close();
  }
}, 30_000);
