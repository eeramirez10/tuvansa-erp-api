import { Client, type ClientProps } from './client.js';
import type { ClientCreateValues, ClientWriteValues } from '../repositories/client-toolbar-repository.js';

export interface ClientCatalogRecord {
  document: ClientProps;
  changes: ClientWriteValues;
  legacy: boolean;
  originalCode: string | null;
  deleted: boolean;
  blocked: boolean | null;
  blockedAt: string | null;
}

export function applyClientValues(base: ClientProps, values: ClientWriteValues): ClientProps {
  const { address, contact, fiscal, terms } = base;
  const creditLimit = values.creditLimit ?? terms.creditLimit;
  return {
    ...base, code: values.code ?? base.code, name: values.name ?? base.name,
    address: {
      street: values.street ?? address.street, exteriorNumber: values.exteriorNumber ?? address.exteriorNumber,
      interiorNumber: values.interiorNumber ?? address.interiorNumber, neighborhood: values.neighborhood ?? address.neighborhood,
      borough: values.borough ?? address.borough, city: values.city ?? address.city, state: values.state ?? address.state,
      postalCode: values.postalCode ?? address.postalCode, countryCode: values.countryCode ?? address.countryCode,
    },
    contact: {
      name: values.contactName ?? contact.name, phones: values.phones ?? contact.phones, fax: values.fax ?? contact.fax,
      email: values.email ?? contact.email, website: values.website ?? contact.website,
    },
    fiscal: {
      taxId: values.taxId ?? fiscal.taxId, curp: values.curp ?? fiscal.curp, branch: values.branch ?? fiscal.branch,
      accountingAccount: values.accountingAccount ?? fiscal.accountingAccount,
    },
    terms: {
      priceList: values.priceList ?? terms.priceList,
      discounts: [values.discount1 ?? terms.discounts[0], values.discount2 ?? terms.discounts[1], values.discount3 ?? terms.discounts[2]],
      paymentTermDays: values.paymentTermDays ?? terms.paymentTermDays, creditLimit,
      creditExpiresAt: values.creditExpiresAt === undefined ? terms.creditExpiresAt : values.creditExpiresAt,
      reviewDay: values.reviewDay ?? terms.reviewDay, reviewTime: values.reviewTime ?? terms.reviewTime,
      paymentDay: values.paymentDay ?? terms.paymentDay, paymentTime: values.paymentTime ?? terms.paymentTime,
      applyToClientCode: values.applyToClientCode ?? terms.applyToClientCode,
      reviewStartsFromInvoice: values.reviewStartsFromInvoice ?? terms.reviewStartsFromInvoice,
    },
    totals: {
      ...base.totals, availableCredit: values.creditLimit === undefined ? base.totals.availableCredit
        : Math.max(creditLimit - base.totals.currentBalance, 0),
    },
  };
}

export function newCatalogClient(id: number, values: ClientCreateValues, date: string): ClientProps {
  return applyClientValues({
    id, code: values.code, name: values.name, isActive: true, deactivatedAt: null, createdAt: date,
    address: { street: '', exteriorNumber: '', interiorNumber: '', neighborhood: '', borough: '', city: '', state: '', postalCode: '', countryCode: '' },
    contact: { name: '', phones: '', fax: '', email: '', website: '' },
    fiscal: { taxId: '', curp: '', branch: '', accountingAccount: '1105001' },
    terms: {
      priceList: 1, discounts: [0, 0, 0], paymentTermDays: 0, creditLimit: 0, creditExpiresAt: null,
      reviewDay: '', reviewTime: '', paymentDay: '', paymentTime: '', applyToClientCode: '', reviewStartsFromInvoice: false,
    },
    totals: {
      actualPaymentTermDays: values.paymentTermDays ?? 0, previousBalance: 0, currentBalance: 0, availableCredit: 0, accumulatedSales: 0,
      lastPurchaseAt: null, lastPaymentAt: null, lastOrderAt: null,
    },
    indicators: { hasEvents: false },
  }, values);
}

export function presentCatalogClient(base: Client | null, record: ClientCatalogRecord | null): Client | null {
  if (!record) return base;
  if (record.deleted || (record.legacy && !base)) return null;
  const client = base ? applyClientValues(base.toPrimitives(), record.changes) : record.document;
  return Client.create(record.blocked === null ? client : {
    ...client, deactivatedAt: record.blockedAt, isActive: !record.blocked, indicators: { ...client.indicators, hasEvents: true },
  });
}
