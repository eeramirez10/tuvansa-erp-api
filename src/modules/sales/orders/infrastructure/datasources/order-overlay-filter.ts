import type { OrderProps } from '../../domain/entities/order.js';
import type { OrderSearchCriteria } from '../../domain/repositories/orders-repository.js';

const fold = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase();
// Match the legacy LIKE behavior (including user % and _ wildcards), without SQL concatenation.
const like = (value: string, pattern: string) => {
  const escaped=(c:string)=>c.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  const chars=fold(pattern).split('');
  let regex='';
  for(let i=0;i<chars.length;i++) {
    const c=chars[i]!;
    if(c==='\\' && i+1<chars.length) regex+=escaped(chars[++i]!);
    else regex+=c==='%' ? '.*' : c==='_' ? '.' : escaped(c);
  }
  return new RegExp(`^${regex}$`,'s').test(fold(value));
};
export function matchesOrder(o: OrderProps, c: OrderSearchCriteria): boolean {
  if (!['order','quote'].includes(o.documentKind)) return false;
  if (c.after && compareOrders(o,{...o,...c.after})<=0) return false;
  if (c.before && compareOrders(o,{...o,...c.before})>=0) return false;
  if (c.query !== undefined && ![o.number,o.customerOrderNumber,o.customer.code,o.customer.name].some(v => like(v,`%${c.query}%`))) return false;
  const prefixes: Array<[string, string | undefined]> = [[o.number,c.orderNumber],[o.customerOrderNumber,c.customerOrderNumber],
    [o.status,c.status],[o.customer.code,c.customerCode],[o.classifications[0] ?? '',c.agent],[o.warehouse,c.warehouse]];
  if (prefixes.some(([v,p]) => p !== undefined && !like(v,`${p}%`))) return false;
  if (c.orderedAt !== undefined && o.dates.orderedAt !== c.orderedAt) return false;
  if (c.dueAt !== undefined && o.dates.dueAt !== c.dueAt) return false;
  if (c.branch !== undefined && o.branch !== c.branch) return false;
  if (c.minimumFulfillmentPercentage !== undefined && o.minimumFulfillmentPercentage !== c.minimumFulfillmentPercentage) return false;
  if (c.from !== undefined && (!o.dates.orderedAt || o.dates.orderedAt < c.from)) return false;
  if (c.to !== undefined && (!o.dates.orderedAt || o.dates.orderedAt > c.to)) return false;
  if (c.authorization !== undefined) {
    if (/^O\.?K\.?$/i.test(c.authorization)) { if (!o.authorization) return false; }
    else if (!like(o.authorization || '0',`${c.authorization}%`)) return false;
  }
  return true;
}
export const compareOrders = (a: OrderProps, b: OrderProps) =>
  fold(a.number).localeCompare(fold(b.number),'en') || a.id-b.id;
