import { Supplier, type SupplierProps } from './supplier.js';
import type { SupplierActivityChange } from './supplier-activity.js';

export type SupplierCatalogFields = Pick<SupplierProps, 'code' | 'name' | 'address' | 'contact' | 'fiscal' | 'terms' | 'notes'>;

export interface SupplierCatalogParameters {
  tolerancePercent: number;
  vatCode: number;
  withheldVat: number;
  withheldIncomeTax: number;
  intercompany: number;
}

export interface SupplierCatalogRecord extends SupplierCatalogParameters {
  supplier: SupplierProps;
  legacy: boolean;
  deleted: boolean;
  revision: number;
  originalCode: string | null;
  classifications?: string[] | null;
  classificationWrite?: { requestKey: string; previousRevision: number } | null;
  activity?: SupplierActivityChange[] | null;
  various?: SupplierVariousFields | null;
  variousWrite?: { requestKey: string; fingerprint: string; revision: number; date: string } | null;
}

export interface SupplierVariousFields {
  branch: string;
  bankAccount: string;
  bankCode: string;
  city: string;
  state: string;
  cieReference: string;
  internetPassword: string;
  multiCompany: number;
  interCompany: number;
  deliveryDays: number;
  purchaseFrequencyDays: number;
  tolerancePercent: number;
  vatType: number;
  vatWithholdingPercent: number;
  incomeTaxWithholdingPercent: number;
  thirdPartyType: string;
  operationType: string;
  countryCode: string;
  minimums: number[];
  values: number[];
}

export function blankSupplierVarious(parameters: SupplierCatalogParameters): SupplierVariousFields {
  return {
    branch: '', bankAccount: '', bankCode: '', city: '', state: '', cieReference: '', internetPassword: '',
    multiCompany: 0, interCompany: parameters.intercompany, deliveryDays: 0, purchaseFrequencyDays: 0,
    tolerancePercent: parameters.tolerancePercent, vatType: parameters.vatCode,
    vatWithholdingPercent: parameters.withheldVat, incomeTaxWithholdingPercent: parameters.withheldIncomeTax,
    thirdPartyType: '', operationType: '', countryCode: '', minimums: Array<number>(8).fill(0), values: Array<number>(12).fill(0),
  };
}

export interface SupplierClassificationUpdate {
  current: string[];
  revision: number;
  requestKey: string;
}

export const supplierClassifierLength = (position: number) => position === 1 ? 5 : 4;

export const supplierCatalogFields = ({ code, name, address, contact, fiscal, terms, notes }: SupplierProps): SupplierCatalogFields => ({
  code, name, address, contact, fiscal, terms, notes,
});

export const nativeSupplierParameters: SupplierCatalogParameters = {
  tolerancePercent: 10, vatCode: 0, withheldVat: 0, withheldIncomeTax: 0, intercompany: 0,
};

export function blankSupplierCatalog(accountingAccount: string): SupplierCatalogFields {
  return {
    code: '', name: '', notes: '',
    address: { street: '', neighborhood: '', city: '', state: '', postalCode: '' },
    contact: { name: '', phone: '', phone2: '', fax: '', email: '' },
    fiscal: { taxId: '', curp: '', accountingAccount },
    terms: { priceList: 1, discounts: [0, 0], paymentTermDays: 0, applyToSupplierCode: '', creditLimit: 0, currencyId: 1, type: 0 },
  };
}

export const newSupplier = (id: number, fields: SupplierCatalogFields, createdAt: string): SupplierProps => ({
  ...fields, id, createdAt, isActive: true, deactivatedAt: null, indicators: { hasEvents: false },
  totals: {
    actualPaymentTermDays: 0, previousBalance: 0, currentBalance: 0, accumulatedPurchases: 0,
    lastPurchaseAt: null, lastPaymentAt: null,
  },
});

export function presentSupplierCatalog(base: Supplier | null, record: SupplierCatalogRecord | null): Supplier | null {
  if (!record) return base;
  if (record.deleted) return null;
  if (!record.legacy) return Supplier.create(record.supplier);
  return base ? Supplier.create({
    ...base.toPrimitives(), ...supplierCatalogFields(record.supplier),
    ...(record.activity?.some(({ kind }) => kind === 'events') ? { indicators: record.supplier.indicators } : {}),
  }) : null;
}
