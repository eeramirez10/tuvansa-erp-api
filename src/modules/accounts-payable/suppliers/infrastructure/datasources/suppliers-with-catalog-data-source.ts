import type { SuppliersDataSource } from '../../domain/datasources/suppliers-data-source.js';
import type { Supplier } from '../../domain/entities/supplier.js';
import { presentSupplierCatalog } from '../../domain/entities/supplier-catalog.js';
import type { SupplierNavigationDirection, SupplierSearchCriteria, SupplierSearchResult } from '../../domain/repositories/suppliers-repository.js';
import { LegacyMysqlSuppliersDataSource } from './legacy-mysql-suppliers-data-source.js';
import { isLocalSupplierCatalogId, PostgresSupplierCatalogDataSource, supplierCatalogRecord } from './postgres-supplier-catalog-data-source.js';

const compare = (left: Supplier, right: Supplier) => {
  const a = left.toPrimitives();
  const b = right.toPrimitives();
  const aCode = a.code.toUpperCase(), bCode = b.code.toUpperCase();
  return aCode === bCode ? a.id - b.id : aCode < bCode ? -1 : 1;
};

const normalizeText = (value: string) => value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

export class SuppliersWithCatalogDataSource implements SuppliersDataSource {
  constructor(private readonly legacy = new LegacyMysqlSuppliersDataSource(), private readonly catalog = new PostgresSupplierCatalogDataSource()) {}

  async findById(id: number): Promise<Supplier | null> {
    const [base, record] = await Promise.all([isLocalSupplierCatalogId(id) ? null : this.legacy.findById(id), supplierCatalogRecord(id)]);
    return presentSupplierCatalog(base, record);
  }

  private async projected() {
    const records = await this.catalog.list();
    const excluded = records.filter(({ legacy }) => legacy).map(({ supplier }) => supplier.id);
    const baselines = await this.legacy.findByIds(records.filter(({ legacy, deleted }) => legacy && !deleted).map(({ supplier }) => supplier.id));
    const visible = records.map((record) => presentSupplierCatalog(baselines.get(record.supplier.id) ?? null, record))
      .filter((supplier) => supplier !== null);
    return { excluded, visible };
  }

  async findFirst(): Promise<Supplier | null> {
    const { excluded, visible } = await this.projected();
    const base = await this.legacy.findFirstExcluding(excluded);
    return [...visible, ...(base ? [base] : [])].sort(compare)[0] ?? null;
  }

  async findAdjacent(id: number, direction: SupplierNavigationDirection): Promise<Supplier | null> {
    const [current, { excluded, visible }] = await Promise.all([this.findById(id), this.projected()]);
    if (!current) return null;
    const { code } = current.toPrimitives();
    const base = await this.legacy.findAdjacentByCode(code, id, direction, excluded);
    const previous = direction === 'previous';
    const candidates = visible.filter((supplier) => compare(supplier, current) * (previous ? -1 : 1) > 0);
    if (base) candidates.push(base);
    return candidates.sort((left, right) => compare(left, right) * (previous ? -1 : 1))[0] ?? null;
  }

  async search(criteria: SupplierSearchCriteria): Promise<SupplierSearchResult> {
    const { excluded, visible } = await this.projected();
    const { query, status, limit, offset } = criteria;
    const needle = query === undefined ? null : normalizeText(query);
    const matches = visible.filter((supplier) => {
      const { code, name, fiscal, isActive } = supplier.toPrimitives();
      if ((status === 'active' && !isActive) || (status === 'inactive' && isActive)) return false;
      return needle === null || [code, name, fiscal.taxId].some((value) => normalizeText(value).includes(needle));
    });
    const legacyOffset = Math.max(0, offset - matches.length);
    const base = await this.legacy.searchExcluding({ ...criteria, offset: legacyOffset, limit: offset + limit - legacyOffset }, excluded);
    return {
      items: [...base.items, ...matches].sort(compare).slice(offset - legacyOffset, offset + limit - legacyOffset),
      total: Number(base.total) + matches.length,
    };
  }
}
