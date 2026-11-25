import { AsyncLocalStorage } from 'node:async_hooks';
import { NotFoundError } from '../../domain/errors/not-found-error.js';

export const customerScope = new AsyncLocalStorage<ReadonlySet<number> | undefined>();

export function customerAllowed(id: number): boolean {
  return customerScope.getStore()?.has(id) ?? true;
}

export function requireCustomer(id: number): void {
  if (!customerAllowed(id)) throw new NotFoundError('Cliente');
}

// The column name comes from the calling datasource, never from an HTTP request.
export function customerSql(column: 'CLISEQ' | 'FPENC.CLISEQ' | 'FDOC.CLISEQ'): { condition: string; values: number[] } {
  const scope = customerScope.getStore();
  if (!scope) return { condition: '', values: [] };
  const values = [...scope];
  return { condition: values.length ? ` AND ${column} IN (${values.map(() => '?').join(',')})` : ' AND 1=0', values };
}
