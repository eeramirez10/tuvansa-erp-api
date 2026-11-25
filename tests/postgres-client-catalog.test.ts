import { PGlite } from '@electric-sql/pglite';
import { afterAll, expect, it, vi } from 'vitest';
import { newCatalogClient } from '../src/modules/accounts-receivable/clients/domain/entities/client-catalog.js';
import { Client } from '../src/modules/accounts-receivable/clients/domain/entities/client.js';
import { ClientActionsWithCatalogDataSource } from '../src/modules/accounts-receivable/clients/infrastructure/datasources/client-actions-with-catalog-data-source.js';
import { ClientsWithCatalogDataSource } from '../src/modules/accounts-receivable/clients/infrastructure/datasources/clients-with-catalog-data-source.js';
import { LegacyMysqlClientsDataSource } from '../src/modules/accounts-receivable/clients/infrastructure/datasources/legacy-mysql-clients-data-source.js';
import { MysqlCustomerCollectionReferences } from '../src/modules/accounts-receivable/clients/infrastructure/datasources/mysql-customer-collection-references.js';
import { assertClientCatalogCreditAllowed, clientCatalogRecord } from '../src/modules/accounts-receivable/clients/infrastructure/datasources/postgres-client-catalog.js';
import { MysqlInvoiceFromOrderReferences } from '../src/modules/sales/invoicing/infrastructure/datasources/mysql-invoice-from-order-references.js';
import type { OrderProps } from '../src/modules/sales/orders/domain/entities/order.js';
import { LegacyMysqlOrderCaptureDataSource } from '../src/modules/sales/orders/infrastructure/datasources/legacy-mysql-order-capture-data-source.js';
import type { PostgresConnectionFactory } from '../src/shared/infrastructure/database/postgres-pool.js';

const db = new PGlite();
const connect: PostgresConnectionFactory = async () => ({
  async query<T extends object>(sql: string, values?: unknown[]) {
    if (values) return db.query<T>(sql, values);
    const result = await db.exec(sql);
    return { rows: (result.at(-1)?.rows ?? []) as T[] };
  },
  release() {},
});

vi.mock('../src/shared/infrastructure/database/postgres-pool.js', async (importOriginal) => ({
  ...await importOriginal<object>(), connectPostgres: () => connect(), postgresConfigured: () => true,
}));
const legacyExecute = vi.hoisted(() => vi.fn());
vi.mock('../src/shared/infrastructure/database/legacy-mysql-pool.js', () => ({ legacyMysqlPool: { execute: legacyExecute } }));

let base = newCatalogClient(1, { code: 'NAT001', name: 'Cliente original', creditLimit: 90 }, '2025-01-01');

class Legacy extends LegacyMysqlClientsDataSource {
  override async findById(id: number) { return id === base.id ? Client.create(base) : null; }

  override async findByIds(ids: number[]) { return new Map(ids.includes(base.id) ? [[base.id, Client.create(base)]] : []); }

  override async findFirstActiveExcluding(ids: number[]) { return ids.includes(base.id) ? null : Client.create(base); }

  override async searchExcluding() { return { items: [], total: 0 }; }

  override async codeExists(code: string, except?: number) { return code === base.code && base.id !== except; }

  override async catalogAccountSettings() { return { account: '1105002', required: false, active: true }; }

  override async catalogLeafAccount(account: string) { return ['1105001', '1105002'].includes(account); }

  override async findDependency() { return 'fdoc'; }
}

const view = new ClientsWithCatalogDataSource(new Legacy());
afterAll(() => db.close());

it('persiste ficha y bloqueo juntos, refleja el evento una vez y guarda bajas con sus dependencias', async () => {
  const created = (await view.create({ code: 'LOC001', name: 'Cliente web', paymentTermDays: 30, creditLimit: 123 })).toPrimitives();
  const { id } = created;
  expect(created).toMatchObject({ fiscal: { accountingAccount: '1105002' }, terms: { priceList: 1, paymentTermDays: 30 }, totals: { actualPaymentTermDays: 30, availableCredit: 123 } });
  await expect(view.create({ code: 'LOC001', name: 'Otro' })).rejects.toMatchObject({ code: 'CLIENT_CODE_EXISTS' });
  await expect(view.update(id, { accountingAccount: 'MAYOR' })).rejects.toMatchObject({ code: 'ACCOUNTING_ACCOUNT_NOT_FOUND' });
  expect((await view.update(id, { name: 'Cliente actualizado', priceList: 14 }))?.toPrimitives()).toMatchObject({ name: 'Cliente actualizado', terms: { priceList: 1, paymentTermDays: 30 } });
  expect((await view.findFirstActive())?.toPrimitives().id).toBe(id);
  const orderRef = new LegacyMysqlOrderCaptureDataSource();
  expect(await orderRef.customer('LOC001')).toMatchObject({ id, name: 'Cliente actualizado', termsDays: 30 });
  legacyExecute.mockResolvedValueOnce([[]]);
  expect(await orderRef.searchCustomers({ code: 'LOC' }, 10)).toMatchObject([{ id, code: 'LOC001', name: 'Cliente actualizado' }]);

  const invoice = new MysqlInvoiceFromOrderReferences();
  const order = { customer: { id, code: 'LOC001' }, warehouse: '01', termsDays: 30, lines: [] } as unknown as OrderProps;
  const fiscal = { customerCode: null, customerCurrency: 1, blocked: 0, posRestricted: 0, alternateCustomer: null,
    intercompany: 0, withheldVat: 0, customerTermsDays: 0, creditBalance: 0, creditLimit: 0,
    vat: 16, fiscalStart: '2026-01-01', fiscalEnd: '2026-12-31' };
  legacyExecute.mockResolvedValueOnce([[fiscal]]);
  expect(await invoice.context(1, order)).toMatchObject({ reason: null, creditLimit: 123, customerTermsDays: 30 });

  await view.block(id, true, 'Prueba de bloqueo');
  await view.block(id, true, 'Reintento');
  const actions = new ClientActionsWithCatalogDataSource();
  const status = await actions.findBlockStatus(id);
  expect(status).toMatchObject({ payload: { blockStatus: { blocked: true, hasEvents: true,
    event: { title: 'BLOQUEO', key: 'LOC001BLOQUE', description: expect.stringContaining('Prueba de bloqueo') } } } });
  expect(await actions.findEvents({ clientId: id, limit: 1, offset: 0 })).toMatchObject({ total: 1, payload: { events: [{ key: 'LOC001BLOQUE' }] } });
  expect(await actions.findEvents({ clientId: id, limit: 1, offset: 1 })).toMatchObject({ total: 1, payload: { events: [] } });
  await expect(assertClientCatalogCreditAllowed(await connect(), id)).rejects.toMatchObject({ code: 'CLIENT_CREDIT_BLOCKED' });
  await expect(orderRef.customer('LOC001')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  legacyExecute.mockResolvedValueOnce([[fiscal]]);
  expect(await invoice.context(1, order)).toMatchObject({ reason: 'El cliente está bloqueado para facturación.' });
  legacyExecute.mockResolvedValueOnce([[{ policyType: '1', fiscalStart: fiscal.fiscalStart, fiscalEnd: fiscal.fiscalEnd,
    clientAccount: '1105002', clientAccountName: 'CLIENTES' }]]);
  const collection = new MysqlCustomerCollectionReferences({ postingAccounts: async () => [] });
  expect(await collection.settings(1, id)).toMatchObject({ clientAccount: '1105002' });
  expect((await view.findFirstActive())?.toPrimitives().id).toBe(base.id);
  expect((await view.search({ status: 'inactive', limit: 5, offset: 0 })).items[0]?.toPrimitives().id).toBe(id);
  await view.block(id, false, 'Prueba de desbloqueo');
  await view.block(id, false, 'Segundo reintento');
  const reactivated = await actions.findBlockStatus(id);
  expect(reactivated).toMatchObject({ payload: { blockStatus: {
    blocked: false, blockedAt: null, hasEvents: true, event: { title: 'BLOQUEO', key: 'LOC001BLOQUE' },
  } } });
  expect(reactivated?.payload.blockStatus.event?.id).toBe(status?.payload.blockStatus.event?.id);
  expect(reactivated?.payload.blockStatus.event?.description).toMatch(/BLOQUEO.*Prueba de bloqueo\rDESBLOQUEO.*Prueba de desbloqueo/);
  await expect(assertClientCatalogCreditAllowed(await connect(), id)).resolves.toMatchObject({ blocked: false });
  expect(await orderRef.customer('LOC001')).toMatchObject({ id });
  await expect(view.update(id, { code: 'LOC002' })).rejects.toMatchObject({ code: 'CLIENT_IN_USE' });
  await db.exec('CREATE TABLE tuvansa.customer_collections (client_id bigint NOT NULL)');
  await db.query('INSERT INTO tuvansa.customer_collections VALUES($1)', [id]);
  await expect(view.delete(id)).resolves.toEqual({ status: 'in-use', relation: 'customer_collections' });
  await db.query('DELETE FROM tuvansa.customer_collections WHERE client_id=$1', [id]);
  await expect(view.delete(id)).resolves.toEqual({ status: 'deleted' });
  await expect(view.findById(id)).resolves.toBeNull();
  expect(await clientCatalogRecord(id)).toMatchObject({ deleted: true });
  expect((await db.query('SELECT count(*)::int AS size FROM tuvansa.client_block_events')).rows).toEqual([{ size: 2 }]);
}, 30000);

it('conserva los acumulados nativos y rechaza la baja de una ficha heredada con documentos', async () => {
  await expect(view.update(base.id, { name: 'Nombre corregido' })).resolves.toBeInstanceOf(Client);
  base = { ...base, totals: { ...base.totals, currentBalance: 45.65 } };
  expect((await view.findById(base.id))?.toPrimitives()).toMatchObject({ name: 'Nombre corregido', totals: { currentBalance: 45.65 } });
  base = { ...base, isActive: false, deactivatedAt: '2025-07-01' };
  await view.block(base.id, false, 'Desbloqueo de cliente heredado');
  expect((await view.findById(base.id))?.toPrimitives()).toMatchObject({ isActive: true, deactivatedAt: null, indicators: { hasEvents: true } });
  await expect(view.delete(base.id)).resolves.toEqual({ status: 'in-use', relation: 'fdoc' });
}, 30000);
