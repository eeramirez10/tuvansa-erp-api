import type { SuppliersDataSource } from '../../domain/datasources/suppliers-data-source.js';
import type { Supplier } from '../../domain/entities/supplier.js';
import type { SupplierNavigationDirection, SupplierSearchCriteria, SupplierSearchResult, SuppliersRepository } from '../../domain/repositories/suppliers-repository.js';

export class SuppliersRepositoryImpl implements SuppliersRepository {
  constructor(private readonly dataSource: SuppliersDataSource) {}
  findById(id: number): Promise<Supplier | null> { return this.dataSource.findById(id); }
  findFirst(): Promise<Supplier | null> { return this.dataSource.findFirst(); }
  findAdjacent(id: number, direction: SupplierNavigationDirection): Promise<Supplier | null> { return this.dataSource.findAdjacent(id, direction); }
  search(criteria: SupplierSearchCriteria): Promise<SupplierSearchResult> { return this.dataSource.search(criteria); }
}
