export type SupplierActivityKind = 'events' | 'contacts';
export type SupplierActivityOperation = 'create' | 'change' | 'remove';

export interface SupplierActivityCommand {
  requestKey: string;
  revision: number;
  fields: Record<string, string | null>;
}

export interface SupplierActivityChange {
  kind: SupplierActivityKind;
  operation: SupplierActivityOperation;
  id: string | number;
  requestKey: string;
  fingerprint: string;
  item: Record<string, unknown> & { id: string | number; revision: number };
}

export function projectSupplierActivity(
  baseline: Array<Record<string, unknown>>, history: SupplierActivityChange[], kind: SupplierActivityKind,
) {
  const items = new Map(baseline.map((row) => [String(row.id), { ...row, revision: 0 } as Record<string, unknown>]));
  for (const change of history) {
    if (change.kind !== kind) continue;
    const key = String(change.id);
    if (change.operation === 'remove') items.delete(key);
    else items.set(key, change.item);
  }
  return items;
}
