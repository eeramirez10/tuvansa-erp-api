import type { BankAccount } from '../entities/bank-account.js';
import type { BankCatalogFields, BankCatalogSnapshot } from '../entities/bank-catalog.js';

export interface BankCatalogRules {
  accounting: boolean;
  codeLengths: number[];
}

export interface BankCatalogReferences {
  rules(): Promise<BankCatalogRules>;
  findById(id: number): Promise<BankAccount | null>;
  codeExists(code: string): Promise<boolean>;
  hasMovements(id: number): Promise<boolean>;
  hasBalances(id: number): Promise<boolean>;
  hasChildren(code: string): Promise<boolean>;
  parent(code: string): Promise<{ id: number; movements: boolean } | null>;
}

export interface BankCatalogReadSession {
  findById(id: number): Promise<BankCatalogSnapshot | null>;
  findByCode(code: string): Promise<BankCatalogSnapshot | null>;
  hasChildren(code: string): Promise<boolean>;
  hasPostings(id: number, code: string): Promise<boolean>;
  lastIssuedCheque(id: number): Promise<number>;
}

export interface BankCatalogWriteSession extends BankCatalogReadSession {
  lockAccount(id: number): Promise<void>;
  findByRequest(requestKey: string, fingerprint: string): Promise<BankCatalogSnapshot | null>;
  create(input: {
    fields: BankCatalogFields; parentCode: string | null; requestKey: string; fingerprint: string; createdOn: string;
  }): Promise<BankCatalogSnapshot>;
  update(input: {
    id: number; legacy: boolean; fields: BankCatalogFields; revision: number; createdOn: string;
  }): Promise<BankCatalogSnapshot>;
  archive(input: { id: number; legacy: boolean; fields: BankCatalogFields; revision: number; createdOn: string }): Promise<void>;
}

export interface BankCatalogStorage {
  writable(): boolean;
  read<T>(fallback: T, callback: (session: BankCatalogReadSession) => Promise<T>): Promise<T>;
  write<T>(callback: (session: BankCatalogWriteSession) => Promise<T>): Promise<T>;
}
