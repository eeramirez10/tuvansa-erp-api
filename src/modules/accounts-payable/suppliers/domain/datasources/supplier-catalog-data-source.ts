import type { SupplierCatalogParameters, SupplierCatalogRecord } from '../entities/supplier-catalog.js';
import type { Supplier } from '../entities/supplier.js';

export interface SupplierCatalogSettings {
  defaultAccount: string;
  accountingEnabled: boolean;
  accountingAccountRequired: boolean;
}

export interface SupplierCatalogReferences {
  settings(): Promise<SupplierCatalogSettings | null>;
  findById(id: number): Promise<Supplier | null>;
  parameters(id: number): Promise<SupplierCatalogParameters | null>;
  codeExists(code: string, excludeId?: number): Promise<boolean>;
  leafAccount(code: string): Promise<boolean>;
  dependency(id: number, code: string): Promise<string | null>;
}

export interface SupplierCatalogReadSession {
  findById(id: number): Promise<SupplierCatalogRecord | null>;
  dependency(id: number, code: string): Promise<string | null>;
}

export interface SupplierCatalogWriteSession extends SupplierCatalogReadSession {
  lockSupplier(id: number): Promise<void>;
  newId(): Promise<number>;
  findByCode(code: string): Promise<SupplierCatalogRecord | null>;
  findByRequest(key: string, fingerprint: string): Promise<SupplierCatalogRecord | null>;
  save(record: SupplierCatalogRecord, request?: { key: string; fingerprint: string }): Promise<void>;
}

export interface SupplierCatalogStorage {
  writable(): boolean;
  read<T>(fallback: T, operation: (session: SupplierCatalogReadSession) => Promise<T>): Promise<T>;
  write<T>(operation: (session: SupplierCatalogWriteSession) => Promise<T>): Promise<T>;
}
