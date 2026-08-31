import type { Supplier } from '../entities/supplier.js';

export type SupplierNavigationDirection = 'previous' | 'next';

export interface SupplierSearchCriteria {
  query?: string;
  status: 'active' | 'inactive' | 'all';
  limit: number;
  offset: number;
}

export interface SupplierSearchResult {
  items: Supplier[];
  total: number;
}

export interface SuppliersRepository {
  findById(supplierId: number): Promise<Supplier | null>;
  findFirst(): Promise<Supplier | null>;
  findAdjacent(supplierId: number, direction: SupplierNavigationDirection): Promise<Supplier | null>;
  search(criteria: SupplierSearchCriteria): Promise<SupplierSearchResult>;
}
