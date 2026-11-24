import { PGlite } from '@electric-sql/pglite';
import { expect, it, vi } from 'vitest';
import { CaptureSupplierPayment } from '../src/modules/accounts-payable/suppliers/application/use-cases/capture-supplier-payment.js';
import { PostgresSupplierPayments } from '../src/modules/accounts-payable/suppliers/infrastructure/datasources/postgres-supplier-payments.js';
import {
  purchaseReceptionSupplierBalances, purchaseReceptionSupplierCharges,
} from '../src/modules/accounts-payable/suppliers/infrastructure/datasources/purchase-reception-supplier-charges.js';
import { ManagePurchaseReceptionDocumentation } from '../src/modules/purchasing/purchase-receptions/application/use-cases/manage-purchase-reception-documentation.js';
import { HybridPurchaseReceptionsDataSource } from '../src/modules/purchasing/purchase-receptions/infrastructure/datasources/hybrid-purchase-receptions-data-source.js';
import type { LegacyMysqlPurchaseReceptionsDataSource } from '../src/modules/purchasing/purchase-receptions/infrastructure/datasources/legacy-mysql-purchase-receptions-data-source.js';
import type { MysqlPurchaseReceptionDocumentationSource } from '../src/modules/purchasing/purchase-receptions/infrastructure/datasources/mysql-purchase-reception-documentation-source.js';
import { PostgresPurchaseReceptionDocumentations } from '../src/modules/purchasing/purchase-receptions/infrastructure/datasources/postgres-purchase-reception-documentations.js';
import { PostgresPurchasePostingReversals } from '../src/modules/purchasing/purchase-receptions/infrastructure/datasources/postgres-purchase-posting-reversals.js';
import * as postgres from '../src/shared/infrastructure/database/postgres-pool.js';

it('moves a legacy RA balance to separate DO folios and lets an authorized bank payment settle a child', async () => {
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
  const source = {
    id: 343646, number: 'RA09214', amount: 1013.03,
    supplier: { id: 3523, code: '35341', name: 'Proveedor' },
    date: '2025-02-08', dueAt: '2025-04-09', reason: null, version: 'original', nativeRecord: null,
  };
  const native: Pick<MysqlPurchaseReceptionDocumentationSource, 'reception' | 'enabled' | 'numberExists'> = {
    enabled: async () => true,
    numberExists: async (_companyId, numbers) => numbers.includes('DUPLICADO'),
    reception: async (id) => id === source.id ? structuredClone(source) : null,
  };
  const storage = new PostgresPurchaseReceptionDocumentations(native, connect, configured);
  const useCase = new ManagePurchaseReceptionDocumentation(storage);
  const actor = { companyId: 1, userId: 0 };
  const input = {
    requestKey: 'f455eeda-7503-4145-abeb-4994e61626db',
    documents: [{ number: 'DocPrueba1', amount: 805.18 }, { number: 'DOCPRUEBA2', amount: 207.85 }],
  };

  try {
    const preview = await useCase.preview(1, source.id);
    expect(preview).toMatchObject({ canWrite: true, amount: 1013.03, documents: [] });
    expect((await db.query("SELECT to_regclass('tuvansa.purchase_reception_documentations') AS present")).rows)
      .toEqual([{ present: null }]);
    const request = { ...input, revision: preview.revision };
    source.version = 'updated';
    await expect(useCase.save(actor, source.id, request)).rejects.toMatchObject({ code: 'PURCHASE_RECEPTION_DOCUMENTATION_STALE' });
    source.version = 'original';
    await expect(useCase.save(actor, source.id, { ...request, documents: [{ number: 'DUPLICADO', amount: 1013.03 }] }))
      .rejects.toMatchObject({ code: 'PURCHASE_RECEPTION_DOCUMENTATION_NUMBER_EXISTS' });
    await expect(useCase.save(actor, source.id, { ...request, documents: [{ number: 'DESCUADRE', amount: 1013.02 }] }))
      .rejects.toMatchObject({ code: 'PURCHASE_RECEPTION_DOCUMENTATION_INVALID' });

    const saved = await useCase.save(actor, source.id, request);
    expect(saved.documents.map(({ number, amount }) => ({ number, amount }))).toEqual(request.documents);
    expect(await useCase.save(actor, source.id, request)).toEqual(saved);
    expect(await useCase.preview(1, source.id)).toEqual(saved);
    await expect(useCase.save(actor, source.id, { ...request, requestKey: '39a08cd2-7d93-41c6-bfe4-16f493090e9e' }))
      .rejects.toMatchObject({ code: 'PURCHASE_RECEPTION_DOCUMENTATION_BLOCKED' });
    const child = saved.documents[0]!;
    const balances = await purchaseReceptionSupplierBalances([source.supplier.id]);
    expect(balances.get(source.supplier.id)).toBe(0);
    const charges = await purchaseReceptionSupplierCharges(source.supplier.id);
    expect(charges).toMatchObject([
      { number: source.number, remaining: -1013.03, historicalDocumentation: true, documentation: { sourceId: source.id } },
      { number: child.number, principal: 805.18, remaining: 805.18, dueAt: source.dueAt, movementType: 'DO' },
      { number: 'DOCPRUEBA2', remaining: 207.85, movementType: 'DO' },
    ]);

    const payments = new PostgresSupplierPayments(connect, configured);
    const payment = new CaptureSupplierPayment(payments, {
      async settings() {
        return {
          policyType: '2', supplierAccount: '2005002001', supplierAccountName: 'Pasivo',
          bankAccounts: [{ id: 6610, code: '1102100001', name: 'Banco' }],
        };
      },
    });
    const identity = { companyId: 1, supplierId: source.supplier.id, receiptId: child.id };
    const result = await payment.save(identity, 0, {
      requestKey: '383099b1-7a58-42fd-84a9-21690e278964', revision: 1, bankAccountId: 6610,
      mode: 'transfer', amount: 10, date: '2025-04-09', description: 'Pago parcial DO',
    });
    expect(result).toMatchObject({ receiptNumber: child.number, remaining: 795.18 });
    expect(await payments.target(identity)).toMatchObject({ revision: 2, remaining: 795.18 });
    expect((await purchaseReceptionSupplierBalances([source.supplier.id])).get(source.supplier.id)).toBe(-10);
    const reversal = new PostgresPurchasePostingReversals(connect, configured);
    expect(await reversal.snapshot(1, { kind: 'payment', supplierId: source.supplier.id, paymentId: result.id }))
      .toMatchObject({ blocked: null, documents: [{ id: child.id, number: child.number, total: child.amount }] });

    const localId = 6700000000000;
    const localNumber = 'RW00000001';
    const localReceipt = {
      id: localId, number: localNumber, supplier: source.supplier, orderNumber: 'OCW00000001',
      dates: { receivedAt: source.date, dueAt: source.dueAt }, classifications: [],
      totals: { total: 116, balance: 116 },
    };
    await client.query(
      `INSERT INTO tuvansa.purchase_receptions
        (id,number,company_id,user_id,request_key,fingerprint,order_id,order_number,order_revision,result,movement,
         order_line_effects,payable,accounting)
       VALUES ($1,$2,1,0,'a44dab49-3df3-4630-a621-c2110f065ca6',repeat('a',64),1,'OCW00000001',1,
         $3::jsonb,'{"header":{"type":"RA"}}','[]',$4::jsonb,'{"number":"3PW00000001"}')`,
      [localId, localNumber, JSON.stringify({ reception: localReceipt }),
        JSON.stringify({ amount: 116, currencyId: 1, exchangeRate: 1, dueAt: source.dueAt })],
    );
    const local = await useCase.preview(1, localId);
    expect(local).toMatchObject({ canWrite: true, amount: 116 });
    const localIdentity = { ...identity, receiptId: localId };
    expect(await payments.target(localIdentity)).toMatchObject({ remaining: 116 });
    await client.query(`CREATE TABLE tuvansa.purchase_reception_comments (
      company_id integer,receipt_id bigint,receipt_number text,supplier_id bigint,fields jsonb,revision integer
    )`);
    await client.query(
      `INSERT INTO tuvansa.purchase_reception_comments VALUES (1,$1,$2,$3,'{"dueAt":"2025-05-31"}',1)`,
      [localId, localNumber, source.supplier.id],
    );
    const localInput = {
      requestKey: 'e431db52-14b6-4d04-a3fc-28f1289e4b77',
      documents: [{ number: 'DocPrueba3', amount: 116 }],
    };
    await expect(useCase.save(actor, localId, { ...localInput, revision: local.revision }))
      .rejects.toThrow('La recepción cambió');
    await useCase.save(actor, localId, {
      ...localInput, revision: (await useCase.preview(1, localId)).revision,
    });
    const inheritedDate = await client.query(
      'SELECT due_date::text AS "dueAt" FROM tuvansa.purchase_reception_documentations WHERE source_id=$1', [localId],
    );
    expect(inheritedDate.rows).toEqual([{ dueAt: '2025-05-31' }]);
    expect(await payments.target(localIdentity)).toMatchObject({ remaining: 0 });
    expect((await purchaseReceptionSupplierBalances([source.supplier.id])).get(source.supplier.id)).toBe(106);
    const hybrid = new HybridPurchaseReceptionsDataSource({} as LegacyMysqlPurchaseReceptionsDataSource);
    const panel = await hybrid.getPanel(localId, 'auxiliary');
    expect(panel).toMatchObject({
      items: [{ transactionType: 'RA', signedAmount: 116 }, { transactionType: 'DO', signedAmount: -116 }],
      summary: { total: 0 },
    });
  } finally {
    configuredMock.mockRestore();
    connectMock.mockRestore();
    await db.close();
  }
}, 15_000);
