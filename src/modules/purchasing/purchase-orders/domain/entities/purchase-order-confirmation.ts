import type { PurchaseOrderConfirmationMode, PurchaseOrderConfirmedStock } from '../datasources/purchase-order-confirmation-data-source.js';
import type { PurchaseOrderLine } from './purchase-order.js';

const quantity = (value: number) => Number(value.toFixed(3));

export function assignPurchaseOrderLines(current: PurchaseOrderLine[], legacy: PurchaseOrderLine[], mode: PurchaseOrderConfirmationMode) {
  const assignedByProduct = new Map<number, number>(legacy.map(({ productId }) => [productId, 0]));
  let marker: string | undefined;
  let assignedTotal = 0;
  const lines = current.map((line) => {
    const assigned = mode === 'confirm' ? quantity(line.ordered - line.fulfilled) : 0;
    if (assigned !== line.assigned) marker = assigned > line.assigned ? 'ASIGNAD' : '';
    assignedTotal += assigned;
    assignedByProduct.set(line.productId, (assignedByProduct.get(line.productId) ?? 0) + assigned);
    return assigned === line.assigned ? line : { ...line, assigned, confirmed: assigned !== 0 };
  });
  if (marker === undefined) return null;
  const stock: PurchaseOrderConfirmedStock[] = [...assignedByProduct].map(([productId, assigned]) => ({ productId, assigned: quantity(assigned) }));
  return { lines, assigned: quantity(assignedTotal), stock, marker };
}
