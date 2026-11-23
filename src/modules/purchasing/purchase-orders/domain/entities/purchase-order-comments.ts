import type { PurchaseOrderProps } from './purchase-order.js';

export interface PurchaseOrderCommentFields {
  from: string | null;
  dueAt: string | null;
  terms: number;
  supplierOrderNumber: string;
  department: string;
  discountPercentages: [number, number, number];
  exchangeRate: number;
  warehouse: string;
  currencyId: number;
  lines: [string, string, string, string, string];
  otherLabel: string;
  freight: number;
  insurance: number;
  other: number;
  confirmedAt: string | null;
}

export interface PurchaseOrderCommentsSnapshot {
  fields: PurchaseOrderCommentFields;
  currencyName: string;
  manualConfirmation: { date: string | null; changedAt: string } | null;
}

export function applyPurchaseOrderCommentFields(base: PurchaseOrderProps, fields: PurchaseOrderCommentFields): PurchaseOrderProps {
  const { from, dueAt, supplierOrderNumber, department, discountPercentages, warehouse, otherLabel, freight, insurance, other } = fields;
  return {
    ...base,
    dates: { ...base.dates, from, dueAt },
    supplierOrderNumber, department, discountPercentages, warehouse, otherLabel,
    totals: { ...base.totals, freight, insurance, other },
  };
}
