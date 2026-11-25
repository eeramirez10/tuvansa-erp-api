import type { PostgresClient } from '../../../../../shared/infrastructure/database/postgres-pool.js';
import type { BankAccountsDataSource } from '../../domain/datasources/bank-accounts-data-source.js';
import type { BankCatalogReadSession } from '../../domain/datasources/bank-catalog-data-source.js';
import type { BankAccount, BankAccountLookup, BankAccountProps } from '../../domain/entities/bank-account.js';
import { permitsBankPosting } from '../../domain/entities/bank-posting-role.js';
import { projectBankCatalog, type BankCatalogSnapshot } from '../../domain/entities/bank-catalog.js';
import type { BankAccountNavigationDirection, BankAccountSearchCriteria, BankAccountSearchResult } from '../../domain/repositories/bank-accounts-repository.js';
import { LegacyMysqlBankAccountsDataSource } from './legacy-mysql-bank-accounts-data-source.js';
import { isLocalBankCatalogId, PostgresBankCatalogDataSource } from './postgres-bank-catalog-data-source.js';

function compareCodes(left: string, right: string): number {
  return left < right ? -1 : Number(left > right);
}

export class BankAccountsWithCatalogDataSource implements BankAccountsDataSource {
  constructor(
    private readonly legacy = new LegacyMysqlBankAccountsDataSource(),
    private readonly catalog = new PostgresBankCatalogDataSource(),
  ) {}

  private async accountById(id: number, client?: PostgresClient): Promise<BankAccount | null> {
    const base = isLocalBankCatalogId(id) ? null : await this.legacy.findById(id);
    if (!base && !isLocalBankCatalogId(id)) return null;
    const read = async (catalog: BankCatalogReadSession) => {
      const snapshot = await catalog.findById(id);
      const code = snapshot?.fields.code ?? base?.toPrimitives().code;
      return { snapshot, children: code ? await catalog.hasChildren(code) : false };
    };
    const { snapshot, children } = client ? await this.catalog.readOn(client, read)
      : await this.catalog.read({ snapshot: null, children: false }, read);
    return projectBankCatalog(base, snapshot, children);
  }

  lookupOn(client: PostgresClient): BankAccountLookup {
    return async (id) => (await this.accountById(id, client))?.toPrimitives() ?? null;
  }

  findById(id: number) { return this.accountById(id); }

  async postingAccounts(companyId: number, role: 'payments' | 'deposits', id?: number, lookup?: BankAccountLookup) {
    if (id !== undefined) {
      const account = lookup ? await lookup(id) : (await this.accountById(id))?.toPrimitives();
      return account && permitsBankPosting(account, companyId, role) ? [account] : [];
    }
    const limit = 250;
    const applicable: BankAccountProps[] = [];
    let offset = 0;
    for (;;) {
      const { items, total } = await this.search({ offset, limit });
      applicable.push(...items.map((item) => item.toPrimitives()).filter((account) => permitsBankPosting(account, companyId, role)));
      offset += items.length;
      if (items.length === 0 || offset >= total) return applicable;
    }
  }

  async findByCode(code: string): Promise<BankAccount | null> {
    const local = await this.catalog.read(null as BankCatalogSnapshot | null, (catalog) => catalog.findByCode(code));
    if (local) return this.accountById(local.id);
    const legacy = await this.legacy.findByCode(code);
    if (!legacy) return null;
    const fields = legacy.toPrimitives();
    const children = await this.catalog.read(false, (catalog) => catalog.hasChildren(fields.code));
    return projectBankCatalog(legacy, null, children);
  }

  async findFirst(): Promise<BankAccount | null> {
    const [excluded, local] = await Promise.all([this.catalog.archivedLegacyIds(), this.catalog.firstByCode(null, false)]);
    const legacy = excluded.length ? await this.legacy.findFirstExcluding(excluded) : await this.legacy.findFirst();
    const baseline = legacy?.toPrimitives();
    if (local && (!baseline || compareCodes(local.fields.code, baseline.code) < 0)) return this.findById(local.id);
    return baseline ? this.findById(baseline.id) : null;
  }

  async findAdjacent(id: number, direction: BankAccountNavigationDirection): Promise<BankAccount | null> {
    const current = await this.accountById(id);
    if (!current) return null;
    const { code } = current.toPrimitives();
    const previous = direction === 'previous';
    const [excluded, local] = await Promise.all([this.catalog.archivedLegacyIds(), this.catalog.firstByCode(code, previous)]);
    const legacy = await this.legacy.findAdjacentByCode(code, direction, excluded);
    const baseline = legacy?.toPrimitives();
    if (local && (!baseline || (previous ? local.fields.code > baseline.code : local.fields.code < baseline.code))) {
      return this.findById(local.id);
    }
    return baseline ? this.findById(baseline.id) : null;
  }

  async search(criteria: BankAccountSearchCriteria): Promise<BankAccountSearchResult> {
    const { offset, limit } = criteria;
    const local = await this.catalog.search(criteria, offset + limit);
    const legacyOffset = Math.max(offset - local.total, 0);
    const legacyCriteria = { ...criteria, offset: legacyOffset, limit: offset + limit - legacyOffset };
    const legacy = local.edits.length > 0
      ? await this.legacy.searchExcluding(legacyCriteria, local.edits)
      : await this.legacy.search(legacyCriteria);
    const merged = [
      ...legacy.items.map((base) => {
        const { id, code } = base.toPrimitives();
        return { id, code, base, snapshot: null };
      }),
      ...local.items.map((snapshot) => ({
        id: snapshot.id, code: snapshot.fields.code, base: null, snapshot,
      })),
    ].sort((left, right) => compareCodes(left.code, right.code) || left.id - right.id);
    const page = merged.slice(offset - legacyOffset, offset + limit - legacyOffset);
    const children = await this.catalog.childrenOf(page.map(({ code }) => code));
    const accounts = await Promise.all(page.map(async ({ id, code, base, snapshot }) => {
      const baseline = snapshot?.legacy ? await this.legacy.findById(id) : base;
      return projectBankCatalog(baseline, snapshot, children.has(code));
    }));
    return { items: accounts.filter((account) => account !== null), total: Number(legacy.total) + local.total };
  }
}
