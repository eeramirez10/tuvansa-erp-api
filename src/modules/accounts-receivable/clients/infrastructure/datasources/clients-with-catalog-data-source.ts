import { ConflictError } from '../../../../../shared/domain/errors/conflict-error.js';
import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import { NotFoundError } from '../../../../../shared/domain/errors/not-found-error.js';
import type { PostgresClient } from '../../../../../shared/infrastructure/database/postgres-pool.js';
import type { ClientsDataSource } from '../../domain/datasources/clients-data-source.js';
import { Client } from '../../domain/entities/client.js';
import { applyClientValues, newCatalogClient, presentCatalogClient, type ClientCatalogRecord } from '../../domain/entities/client-catalog.js';
import type { ClientCreateValues, ClientNavigationDirection, ClientWriteValues, DeleteClientResult } from '../../domain/repositories/client-toolbar-repository.js';
import type { ClientSearchCriteria, ClientSearchResult } from '../../domain/repositories/clients-repository.js';
import { LegacyMysqlClientsDataSource } from './legacy-mysql-clients-data-source.js';
import {
  allClientCatalogRecords, clientCatalogRecord, findClientCatalogByCode, isLocalClientCatalogId, lockClientCatalogCredit, PostgresClientCatalog,
} from './postgres-client-catalog.js';

const date = new Intl.DateTimeFormat('sv-SE', { dateStyle: 'short', timeZone: 'America/Mexico_City' });
const normalize = (value: string) => value.normalize('NFD').replace(/\p{M}/gu, '').toUpperCase();
const compare = (left: Client, right: Client) => {
  const a = left.toPrimitives(), b = right.toPrimitives();
  const aCode = normalize(a.code), bCode = normalize(b.code);
  return aCode === bCode ? a.id - b.id : aCode < bCode ? -1 : 1;
};

type CurrentClient = { base: Client | null; record: ClientCatalogRecord | null };

export class ClientsWithCatalogDataSource implements ClientsDataSource {
  constructor(private readonly legacy = new LegacyMysqlClientsDataSource(), private readonly catalog = new PostgresClientCatalog()) {}

  private async state(id: number, transaction?: PostgresClient): Promise<CurrentClient> {
    const [base, record] = await Promise.all([isLocalClientCatalogId(id) ? null : this.legacy.findById(id), clientCatalogRecord(id, transaction)]);
    return { base, record };
  }

  async findById(id: number): Promise<Client | null> {
    const state = await this.state(id);
    return presentCatalogClient(state.base, state.record);
  }

  private async projected() {
    const records = await allClientCatalogRecords();
    const excluded = records.filter(({ legacy }) => legacy).map(({ document }) => document.id);
    const base = await this.legacy.findByIds(records.filter(({ legacy, deleted }) => legacy && !deleted).map(({ document }) => document.id));
    return { excluded, visible: records.map((record) => presentCatalogClient(base.get(record.document.id) ?? null, record)).filter((client) => client !== null) };
  }

  async findFirstActive(): Promise<Client | null> {
    const { excluded, visible } = await this.projected();
    const base = await this.legacy.findFirstActiveExcluding(excluded);
    return [...visible.filter((client) => client.toPrimitives().isActive), ...(base ? [base] : [])].sort(compare)[0] ?? null;
  }

  async findAdjacent(id: number, direction: ClientNavigationDirection): Promise<Client | null> {
    const [current, { excluded, visible }] = await Promise.all([this.findById(id), this.projected()]);
    if (!current) return null;
    const { code } = current.toPrimitives();
    const base = await this.legacy.findAdjacentByCode(code, direction, excluded);
    const sign = direction === 'previous' ? -1 : 1;
    const candidates = visible.filter((client) => compare(client, current) * sign > 0);
    if (base) candidates.push(base);
    return candidates.sort((left, right) => compare(left, right) * sign)[0] ?? null;
  }

  async search(criteria: ClientSearchCriteria): Promise<ClientSearchResult> {
    const { excluded, visible } = await this.projected();
    const { offset, limit, status, query } = criteria;
    const key = query === undefined ? null : normalize(query);
    const matches = visible.filter((client) => {
      const { code, name, fiscal, isActive } = client.toPrimitives();
      if ((status === 'active' && !isActive) || (status === 'inactive' && isActive)) return false;
      return key === null || [code, name, fiscal.taxId].some((value) => normalize(value).includes(key));
    });
    const skip = Math.max(0, offset - matches.length);
    const base = await this.legacy.searchExcluding({ ...criteria, offset: skip, limit: offset + limit - skip }, excluded);
    return { items: [...matches, ...base.items].sort(compare).slice(offset - skip, offset + limit - skip), total: Number(base.total) + matches.length };
  }

  async codeExists(code: string, excludingClientId?: number) {
    const [legacy, record] = await Promise.all([this.legacy.codeExists(code, excludingClientId), findClientCatalogByCode(code)]);
    return legacy || Boolean(record && normalize(record.document.code) === normalize(code) && record.document.id !== excludingClientId);
  }

  private async accountSettings() {
    const settings = await this.legacy.catalogAccountSettings();
    if (!settings) throw new ApplicationError('La configuración contable de clientes no está disponible.', 'CLIENT_CATALOG_CONFIG_UNAVAILABLE', 503);
    return settings;
  }

  async accountingAccountExists(account: string) {
    const settings = await this.accountSettings();
    if (!settings.active) return true;
    return account ? this.legacy.catalogLeafAccount(account) : !settings.required;
  }

  async defaultAccountingAccount() { return (await this.accountSettings()).account; }

  private async validateCode(transaction: PostgresClient, code: string, id?: number) {
    if (await this.legacy.codeExists(code, id) || await this.catalog.codeExists(transaction, code, id)) {
      throw new ConflictError('Ya existe un cliente con ese código.', 'CLIENT_CODE_EXISTS');
    }
  }

  private async validateAccount(account: string) {
    if (!await this.accountingAccountExists(account)) throw new ConflictError('La cuenta contable no existe.', 'ACCOUNTING_ACCOUNT_NOT_FOUND');
  }

  create(values: ClientCreateValues): Promise<Client> {
    return this.catalog.write(async (transaction) => {
      await this.validateCode(transaction, values.code);
      const account = values.accountingAccount ?? (await this.accountSettings()).account;
      await this.validateAccount(account);
      const normalized = { ...values, accountingAccount: account };
      const document = newCatalogClient(await this.catalog.allocate(transaction), normalized, date.format());
      await this.catalog.save(transaction, { document, changes: normalized, legacy: false, originalCode: null, blocked: null, blockedAt: null, deleted: false });
      return Client.create(document);
    });
  }

  private async dependency(transaction: PostgresClient, client: Client, state: CurrentClient, renaming = false) {
    const { id, code } = client.toPrimitives();
    return (state.base ? await this.legacy.findDependency(id, state.base.toPrimitives().code) : null)
      ?? await this.catalog.dependency(transaction, id, code, renaming);
  }

  update(id: number, values: ClientWriteValues): Promise<Client | null> {
    return this.catalog.write(async (transaction) => {
      await lockClientCatalogCredit(transaction, id);
      const current = await this.state(id, transaction);
      const client = presentCatalogClient(current.base, current.record);
      if (!client) return null;
      const priceList = values.priceList ?? client.toPrimitives().terms.priceList;
      const normalized = priceList < 1 || priceList > 13 ? { ...values, priceList: 1 } : values;
      const document = applyClientValues(client.toPrimitives(), normalized);
      if (values.code !== undefined && values.code !== client.toPrimitives().code) {
        const relation = await this.dependency(transaction, client, current, true)
          ?? (current.base && await this.legacy.hasCatalogBranches(id) ? 'FSUCURSALES' : null);
        if (relation) throw new ConflictError(`El cliente tiene registros relacionados en ${relation}.`, 'CLIENT_IN_USE');
        await this.validateCode(transaction, values.code, id);
      }
      await this.validateAccount(document.fiscal.accountingAccount);
      await this.catalog.save(transaction, {
        document, changes: { ...current.record?.changes, ...normalized }, legacy: Boolean(current.base),
        originalCode: current.record?.originalCode ?? current.base?.toPrimitives().code ?? null,
        deleted: false, blocked: current.record?.blocked ?? null, blockedAt: current.record?.blockedAt ?? null,
      });
      return Client.create(document);
    });
  }

  delete(id: number): Promise<DeleteClientResult> {
    return this.catalog.write(async (transaction) => {
      await lockClientCatalogCredit(transaction, id);
      const current = await this.state(id, transaction);
      const client = presentCatalogClient(current.base, current.record);
      if (!client) return { status: 'not-found' };
      const relation = await this.dependency(transaction, client, current);
      if (relation) return { status: 'in-use', relation };
      await this.catalog.save(transaction, {
        document: client.toPrimitives(), changes: current.record?.changes ?? {}, legacy: Boolean(current.base),
        originalCode: current.record?.originalCode ?? current.base?.toPrimitives().code ?? null,
        deleted: true, blocked: current.record?.blocked ?? null, blockedAt: current.record?.blockedAt ?? null,
      });
      return { status: 'deleted' };
    });
  }

  async block(id: number, blocked: boolean, reason: string): Promise<void> {
    await this.catalog.write(async (transaction) => {
      await lockClientCatalogCredit(transaction, id);
      const current = await this.state(id, transaction);
      const found = presentCatalogClient(current.base, current.record);
      if (!found) throw new NotFoundError('Cliente');
      const document = found.toPrimitives();
      if (blocked === !document.isActive) return;
      const changedAt = date.format();
      await this.catalog.save(transaction, {
        document, changes: current.record?.changes ?? {}, legacy: Boolean(current.base),
        originalCode: current.record?.originalCode ?? current.base?.toPrimitives().code ?? null,
        deleted: false, blocked, blockedAt: blocked ? changedAt : null,
      });
      await this.catalog.createBlockEvent(transaction, id, document.code, changedAt, blocked, reason);
    });
  }
}
