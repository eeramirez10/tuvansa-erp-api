import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import express from 'express';
import request from 'supertest';
import { afterAll, expect, it, vi } from 'vitest';
import { WriteSupplierCatalog } from '../src/modules/accounts-payable/suppliers/application/use-cases/write-supplier-catalog.js';
import { Supplier } from '../src/modules/accounts-payable/suppliers/domain/entities/supplier.js';
import { blankSupplierCatalog, blankSupplierVarious, nativeSupplierParameters, newSupplier } from '../src/modules/accounts-payable/suppliers/domain/entities/supplier-catalog.js';
import { projectSupplierActivity } from '../src/modules/accounts-payable/suppliers/domain/entities/supplier-activity.js';
import type { SupplierSearchCriteria } from '../src/modules/accounts-payable/suppliers/domain/repositories/suppliers-repository.js';
import { LegacyMysqlSuppliersDataSource } from '../src/modules/accounts-payable/suppliers/infrastructure/datasources/legacy-mysql-suppliers-data-source.js';
import { PostgresSupplierCatalogDataSource, searchSupplierCatalogRecords, supplierCatalogRecord } from '../src/modules/accounts-payable/suppliers/infrastructure/datasources/postgres-supplier-catalog-data-source.js';
import { SuppliersWithCatalogDataSource } from '../src/modules/accounts-payable/suppliers/infrastructure/datasources/suppliers-with-catalog-data-source.js';
import { SupplierCatalogController } from '../src/modules/accounts-payable/suppliers/presentation/http/supplier-catalog-controller.js';
import type { PostgresConnectionFactory } from '../src/shared/infrastructure/database/postgres-pool.js';
import { errorHandler } from '../src/shared/infrastructure/http/error-handler.js';

const db = new PGlite();
let failCommit = false;
let next = Promise.resolve();
const connect: PostgresConnectionFactory = async () => {
  // PGlite runs a single SQL session. Independent HTTP requests queue at checkout.
  const previous = next;
  let release!: () => void;
  next = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  return {
    async query<T extends object>(sql: string, values?: unknown[]) {
      if (sql === 'COMMIT' && failCommit) {
        failCommit = false;
        throw new Error('Fallo de prueba antes de confirmar');
      }
      if (values) return db.query<T>(sql, values);
      const result = await db.exec(sql);
      return { rows: (result.at(-1)?.rows ?? []) as T[] };
    },
    release,
  };
};

vi.mock('../src/shared/infrastructure/database/postgres-pool.js', async (importOriginal) => ({
  ...await importOriginal<object>(), connectPostgres: () => connect(), postgresConfigured: () => true,
}));

const defaults = blankSupplierCatalog('2001001');
let original = newSupplier(30, { ...defaults, code: '002000', name: 'Proveedor original' }, '2024-02-01');
let nativeDependency: string | null = null;
const references = {
  settings: async () => ({ defaultAccount: '2001001', accountingEnabled: true, accountingAccountRequired: true }),
  findById: async (id: number) => id === original.id ? Supplier.create(original) : null,
  parameters: async () => ({ ...nativeSupplierParameters, tolerancePercent: 35 }),
  classifications: async () => ['1OLD', '', '', '', '', '', '', '', ''],
  classifiers: async () => [
    { id: 1, code: '1A', number: 'A', description: 'Agente A', type: '1' },
    { id: 2, code: '2B', number: 'B', description: 'Tipo B', type: '2' },
    { id: 3, code: '3C', number: 'C', description: 'Sucursal C', type: '3' },
  ],
  activity: async () => [],
  codeExists: async (code: string, excludeId?: number) => code === original.code && original.id !== excludeId,
  leafAccount: async (code: string) => code === '2001001',
  dependency: async () => nativeDependency,
};

class LegacySuppliers extends LegacyMysqlSuppliersDataSource {
  override findById = references.findById;
  override async findByIds(ids: number[]) {
    return new Map(ids.includes(original.id) ? [[original.id, Supplier.create(original)]] : []);
  }

  override async findFirstExcluding(ids: number[]) {
    return ids.includes(original.id) ? null : Supplier.create(original);
  }

  override async findAdjacentByCode(code: string, _id: number, direction: 'next' | 'previous', ids: number[]) {
    const correctDirection = direction === 'next' ? original.code > code : original.code < code;
    return !ids.includes(original.id) && correctDirection ? Supplier.create(original) : null;
  }

  override async searchExcluding({ query, offset }: SupplierSearchCriteria, ids: number[]) {
    const found = !ids.includes(original.id) && (query === undefined || original.name.includes(query) || original.code.includes(query));
    return { items: found && offset === 0 ? [Supplier.create(original)] : [], total: found ? 1 : 0 };
  }
}

const catalog = new PostgresSupplierCatalogDataSource();
const edits = new WriteSupplierCatalog(catalog, references);
const view = new SuppliersWithCatalogDataSource(new LegacySuppliers(), catalog);
const controller = new SupplierCatalogController(edits, view);
const app = express().use(express.json());
app.get('/create', controller.getCreate).get('/:supplierId/edit', controller.getEdit);
app.post('/', controller.create).patch('/:supplierId', controller.update).delete('/:supplierId', controller.remove);
app.patch('/:supplierId/actions/classifications', controller.classify);
app.patch('/:supplierId/actions/various', controller.saveVarious);
app.post('/:supplierId/actions/events', controller.addActivity('events'));
app.patch('/:supplierId/actions/events/:activityId', controller.changeActivity('events'));
app.delete('/:supplierId/actions/events/:activityId', controller.removeActivity('events'));
app.post('/:supplierId/actions/contacts', controller.addActivity('contacts'));
app.patch('/:supplierId/actions/contacts/:activityId', controller.changeActivity('contacts'));
app.delete('/:supplierId/actions/contacts/:activityId', controller.removeActivity('contacts'));
app.use(errorHandler);

afterAll(() => db.close());

it('guarda Varios junto con los parámetros usados por Compras y conserva la revisión ante fallos', async () => {
  const creation = { requestKey: randomUUID(), fields: { ...defaults, code: 'ZZVR01', name: 'Varios temporal' } };
  const created = (await request(app).post('/').send(creation).expect(201)).body.data;
  const id = Number(created.id);
  const various = `/${id}/actions/various`;
  const command = {
    requestKey: randomUUID(), revision: 1,
    fields: { ...blankSupplierVarious(nativeSupplierParameters), banamexId: 2, tolerancePercent: 27, vatType: 1, vatWithholdingPercent: 1.0625 },
  };
  try {
    await request(app).patch(various).send({ ...command, fields: { ...command.fields, banamexId: 3 } }).expect(400);
    failCommit = true;
    await request(app).patch(various).send(command).expect(503);
    expect(await supplierCatalogRecord(id)).toMatchObject({ various: null, revision: 1, ...nativeSupplierParameters });
    const rival = { ...command, requestKey: randomUUID(), fields: { ...command.fields, tolerancePercent: 42 } };
    const responses = await Promise.all([request(app).patch(various).send(command), request(app).patch(various).send(rival)]);
    expect(responses.map(({ status }) => status).sort()).toEqual([200, 409]);
    const winner = responses[0]!.status === 200 ? command : rival;
    const result = responses.find(({ status }) => status === 200)!.body;
    expect((await request(app).patch(various).send(winner).expect(200)).body).toEqual(result);
    const edit = await request(app).get(`/${id}/edit`).expect(200);
    await request(app).patch(`/${id}`).send({ revision: edit.body.data.revision, fields: { ...creation.fields, notes: 'Temporal' } }).expect(200);
    expect(await supplierCatalogRecord(id)).toMatchObject({
      revision: 3, various: winner.fields, tolerancePercent: winner.fields.tolerancePercent, withheldVat: 1.0625, vatCode: 1,
    });
    const { banamexId, ...rest } = winner.fields;
    await request(app).patch(various).send({ requestKey: randomUUID(), revision: 3, fields: { ...rest, branch: '1234' } }).expect(200);
    expect(await supplierCatalogRecord(id)).toMatchObject({ revision: 4, various: { branch: '1234', banamexId } });
  } finally {
    const edit = await request(app).get(`/${id}/edit`).expect(200);
    await request(app).delete(`/${id}`).send({ revision: edit.body.data.revision, confirmed: true }).expect(204);
  }
});

it('registra eventos y contactos sobre el proveedor con revisiones, reintento y rollback', async () => {
  const command = { requestKey: randomUUID(), fields: { ...defaults, code: 'ZZEV01', name: 'Actividad temporal' } };
  const { body } = await request(app).post('/').send(command).expect(201);
  const id = Number(body.data.id);
  const events = `/${id}/actions/events`;
  const contacts = `/${id}/actions/contacts`;
  const draft = { requestKey: randomUUID(), fields: {
    date: '2026-11-25', title: 'Evento de prueba', description: 'Temporal', followUpAt: null, dueAt: null, project: '',
  } };
  const rows = async (kind: 'events' | 'contacts') =>
    [...projectSupplierActivity([], (await supplierCatalogRecord(id))?.activity ?? [], kind).values()];
  try {
    failCommit = true;
    await request(app).post(events).send(draft).expect(503);
    expect(await rows('events')).toEqual([]);
    expect((await view.findById(id))?.toPrimitives().indicators.hasEvents).toBe(false);
    const created = (await request(app).post(events).send(draft).expect(201)).body.data;
    expect((await request(app).post(events).send(draft).expect(201)).body.data).toEqual(created);
    expect((await view.findById(id))?.toPrimitives().indicators.hasEvents).toBe(true);

    const change = { requestKey: randomUUID(), revision: 1, fields: { ...draft.fields, title: 'Cambió' } };
    const conflicting = { ...change, requestKey: randomUUID(), fields: { ...draft.fields, title: 'Dos sesiones' } };
    const changes = await Promise.all([
      request(app).patch(`${events}/${created.id}`).send(change),
      request(app).patch(`${events}/${created.id}`).send(conflicting),
    ]);
    expect(changes.map(({ status }) => status).sort()).toEqual([200, 409]);
    expect(await rows('events')).toEqual([changes.find(({ status }) => status === 200)!.body.data]);
    const remove = { requestKey: randomUUID(), revision: 2, confirmed: true };
    await request(app).delete(`${events}/${created.id}`).send(remove).expect(204);
    await request(app).delete(`${events}/${created.id}`).send(remove).expect(204);
    expect(await rows('events')).toEqual([]);
    expect((await view.findById(id))?.toPrimitives().indicators.hasEvents).toBe(false);

    const contact = { requestKey: randomUUID(), fields: { name: 'Contacto temporal', position: '', phone1: '', phone2: '', fax: '',
      email: '', notes: '', interests: '', birthday: null } };
    const saved = (await request(app).post(contacts).send(contact).expect(201)).body.data;
    expect(saved).toMatchObject({ name: 'Contacto temporal', ownerCode: 'ZZEV01', revision: 1 });
    expect(await rows('contacts')).toEqual([saved]);

    const path = `${contacts}/${saved.id}`;
    const edit = { requestKey: randomUUID(), revision: 1, fields: { ...contact.fields, position: 'Compras' } };
    await request(app).patch(path).send({ ...edit, fields: { ...edit.fields, ownerCode: '002000' } }).expect(400);
    failCommit = true;
    await request(app).patch(path).send(edit).expect(503);
    expect(await rows('contacts')).toEqual([saved]);

    const rival = { ...edit, requestKey: randomUUID(), fields: { ...edit.fields, position: 'Logística' } };
    const contactChanges = await Promise.all([request(app).patch(path).send(edit), request(app).patch(path).send(rival)]);
    expect(contactChanges.map(({ status }) => status).sort()).toEqual([200, 409]);
    const winningEdit = contactChanges[0]!.status === 200 ? edit : rival;
    const updated = { ...saved, position: winningEdit.fields.position, revision: 2 };
    expect(contactChanges.find(({ status }) => status === 200)!.body.data).toEqual(updated);
    expect(await rows('contacts')).toEqual([updated]);
    expect((await request(app).patch(path).send(winningEdit).expect(200)).body.data).toEqual(updated);
    await request(app).delete(path).send({ ...remove, revision: 1, requestKey: randomUUID() }).expect(409);
    await request(app).delete(path).send({ ...remove, revision: 2, requestKey: randomUUID() }).expect(204);
    expect(await rows('contacts')).toEqual([]);
  } finally {
    const current = await request(app).get(`/${id}/edit`).expect(200);
    await request(app).delete(`/${id}`).send({ revision: current.body.data.revision, confirmed: true }).expect(204);
  }
});

it('guarda nueve clasificadores juntos y conserva el resultado al reintentar o cambiar la ficha', async () => {
  const command = { requestKey: randomUUID(), fields: { ...defaults, code: 'ZZC123', name: 'Temporal' } };
  const created = await request(app).post('/').send(command).expect(201);
  const { id } = created.body.data;
  const path = `/${id}/actions/classifications`;
  const proposal = { current: ['1A', '2B', '', '', '', '', '', '', ''], revision: 1, requestKey: randomUUID() };
  const competing = { current: ['1A', '', '3C', '', '', '', '', '', ''], revision: 1, requestKey: randomUUID() };
  try {
    await request(app).patch(path).send({ ...proposal, current: ['2B', ...proposal.current.slice(1)] }).expect(422);
    failCommit = true;
    await request(app).patch(path).send(proposal).expect(503);
    expect(await supplierCatalogRecord(id)).toMatchObject({ revision: 1, classifications: null });
    const results = await Promise.all([request(app).patch(path).send(proposal), request(app).patch(path).send(competing)]);
    expect(results.map(({ status }) => status).sort()).toEqual([200, 409]);
    const winner = results[0]!.status === 200 ? proposal : competing;
    const expected = { data: { current: winner.current, revision: 2 } };
    expect((await request(app).patch(path).send(winner).expect(200)).body).toEqual(expected);
    expect(await supplierCatalogRecord(id)).toMatchObject({ classifications: winner.current, revision: 2 });
    const edit = await request(app).get(`/${id}/edit`).expect(200);
    await request(app).patch(`/${id}`).send({
      revision: edit.body.data.revision, fields: { ...command.fields, notes: 'Edición temporal' },
    }).expect(200);
    expect(await supplierCatalogRecord(id)).toMatchObject({ classifications: winner.current, revision: 3 });
    expect((await request(app).patch(path).send(winner).expect(200)).body).toEqual(expected);
  } finally {
    const current = await request(app).get(`/${id}/edit`).expect(200);
    await request(app).delete(`/${id}`).send({ revision: current.body.data.revision, confirmed: true }).expect(204);
  }
});

it('registra un proveedor, valida la cuenta y mantiene revisiones y dependencias locales en Baja', async () => {
  const init = await request(app).get('/create').expect(200);
  expect(init.body.data).toMatchObject({ writable: true, accountingAccountRequired: true, fields: defaults });
  const fields = { ...defaults, code: ' 001abc ', name: 'Proveedor web' };
  const command = { requestKey: randomUUID(), fields };
  await request(app).post('/').send({ ...command, fields: { ...fields, fiscal: { ...fields.fiscal, accountingAccount: '' } } }).expect(422);
  await request(app).post('/').send({ ...command, fields: { ...fields, fiscal: { ...fields.fiscal, accountingAccount: 'MAYOR' } } }).expect(422);
  const created = await request(app).post('/').send(command).expect(201);
  const { id } = created.body.data;
  expect(created.body.data).toMatchObject({ code: '001ABC', isActive: true, totals: { currentBalance: 0 } });
  expect((await request(app).post('/').send(command).expect(201)).body).toEqual(created.body);
  await request(app).post('/').send({ ...command, requestKey: randomUUID() }).expect(409);
  expect((await view.findFirst())?.toPrimitives().id).toBe(id);
  expect((await view.findAdjacent(id, 'next'))?.toPrimitives().id).toBe(original.id);

  const edit = await request(app).get(`/${id}/edit`).expect(200);
  expect(edit.body.data).toMatchObject({ codeEditable: true, deletionReason: null });
  const update = { revision: edit.body.data.revision, fields: { ...fields, code: '001ABD', terms: { ...fields.terms, priceList: 6 } } };
  const changed = await request(app).patch(`/${id}`).send(update).expect(200);
  expect(changed.body.data).toMatchObject({ code: '001ABD', terms: { priceList: 1 } });
  await request(app).patch(`/${id}`).send(update).expect(409);
  expect((await view.search({ query: '001ABD', status: 'all', limit: 10, offset: 0 })).total).toBe(1);
  expect(await supplierCatalogRecord(id)).toMatchObject({ legacy: false, deleted: false, ...nativeSupplierParameters });

  const revision = (await request(app).get(`/${id}/edit`).expect(200)).body.data.revision;
  await db.exec('CREATE TABLE tuvansa.purchase_expense_documents (supplier_id bigint NOT NULL)');
  await db.query('INSERT INTO tuvansa.purchase_expense_documents VALUES ($1)', [id]);
  expect((await request(app).get(`/${id}/edit`).expect(200)).body.data).toMatchObject({ codeEditable: false, deletionReason: expect.stringContaining('GA') });
  await request(app).patch(`/${id}`).send({ revision, fields: { ...fields, code: '001ABE' } }).expect(409);
  await request(app).delete(`/${id}`).send({ revision, confirmed: true }).expect(409);
  await db.query('DELETE FROM tuvansa.purchase_expense_documents WHERE supplier_id=$1', [id]);
  await request(app).delete(`/${id}`).send({ revision, confirmed: false }).expect(400);
  await request(app).delete(`/${id}`).send({ revision, confirmed: true }).expect(204);
  await request(app).delete(`/${id}`).send({ revision, confirmed: true }).expect(204);
  await expect(view.findById(id)).resolves.toBeNull();
  expect((await searchSupplierCatalogRecords('001ABD', true))[0]).toMatchObject({ deleted: true });
}, 30000);

it('conserva saldos nativos, protege bajas y detecta cambios del origen durante la edición', async () => {
  const pending = await edits.getEdit(original.id);
  original = { ...original, notes: 'Cambio en origen' };
  await expect(edits.update(original.id, pending.revision, pending.fields)).rejects.toMatchObject({ code: 'SUPPLIER_CATALOG_STALE' });
  nativeDependency = 'El proveedor tiene movimientos en cuentas por pagar.';
  const current = await edits.getEdit(original.id);
  expect(current).toMatchObject({ codeEditable: false, deletionReason: nativeDependency });
  await expect(edits.remove(original.id, current.revision)).rejects.toMatchObject({ code: 'SUPPLIER_CATALOG_LINKED' });
  await edits.update(original.id, current.revision, { ...current.fields, name: 'Proveedor corregido' });
  original = { ...original, totals: { ...original.totals, currentBalance: 42.50 } };
  expect((await view.findById(original.id))?.toPrimitives()).toMatchObject({ name: 'Proveedor corregido', totals: { currentBalance: 42.5 } });
  expect(await supplierCatalogRecord(original.id)).toMatchObject({ legacy: true, originalCode: '002000', tolerancePercent: 35 });
}, 30000);
