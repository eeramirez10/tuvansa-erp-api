import { createHash } from 'node:crypto';
import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import { ConflictError } from '../../../../../shared/domain/errors/conflict-error.js';
import { NotFoundError } from '../../../../../shared/domain/errors/not-found-error.js';
import type {
  ExpenseAccount, ExpenseAccountingLine, ExpenseActor, ExpenseAmounts, ExpenseDocument, ExpenseDocumentLine,
  ExpenseInput, ExpenseProduct, ExpenseReferences, ExpenseSettings, ExpenseStorage, ExpenseSupplier, ExpenseTax,
} from '../../domain/datasources/purchase-expense-data-source.js';

const taxes = ['vat', 'vatWithholding', 'incomeWithholding'] as const;
const amountKeys = ['base', ...taxes] as const;
const taxNames: Record<ExpenseTax, string> = { vat: 'IVA', vatWithholding: 'retención de IVA', incomeWithholding: 'retención de ISR' };
const dateInMexico = new Intl.DateTimeFormat('sv-SE', { dateStyle: 'short', timeZone: 'America/Mexico_City' });
const unsupported = (message: string) => new ApplicationError(message, 'PURCHASE_EXPENSE_UNSUPPORTED', 422);
const zeroAmounts = (): ExpenseAmounts => ({ base: 0, vat: 0, vatWithholding: 0, incomeWithholding: 0 });
const addCents = (left: number, right: number) => {
  const total = left + right;
  if (Math.abs(total) > 999999999999999) throw unsupported('El importe acumulado supera el máximo de la captura GA.');
  return total;
};
const sumAmounts = (totals: ExpenseAmounts, amounts: ExpenseAmounts) => {
  for (const field of amountKeys) totals[field] = addCents(totals[field], amounts[field]);
  return totals;
};
const fromCents = (amounts: ExpenseAmounts): ExpenseAmounts => ({
  base: amounts.base / 100, vat: amounts.vat / 100, vatWithholding: amounts.vatWithholding / 100,
  incomeWithholding: amounts.incomeWithholding / 100,
});

export const expenseCents = (value: number): number | null => {
  const cents = Math.round(value * 100);
  return Number.isSafeInteger(cents) && Math.abs(cents) <= 999999999999 && cents / 100 === value ? cents : null;
};

interface ExpenseGroup {
  supplier: ExpenseSupplier;
  reference: string;
  lines: Map<string, ExpenseDocumentLine>;
}

function getAccount(accounts: Map<string, ExpenseAccount>, code: string, label: string): ExpenseAccount {
  const account = accounts.get(code);
  if (!account) throw unsupported(`${label} requiere una cuenta contable habilitada.`);
  return account;
}

function accountingLine(account: ExpenseAccount, cents: number, department: number, reference?: string): ExpenseAccountingLine {
  return {
    account: account.code, accountId: account.id, accountName: account.name, department,
    debit: Math.max(0, cents) / 100, credit: Math.max(0, -cents) / 100, ...(reference ? { reference } : {}),
  };
}

function selectedTaxAccount(settings: ExpenseSettings, role: ExpenseTax, chosen: string | undefined): ExpenseAccount | null {
  if (!chosen) return settings.defaultTaxAccounts[role];
  const account = settings.taxAccounts[role].find(({ code }) => code === chosen);
  if (!account) throw unsupported(`La cuenta ${chosen} no está disponible para ${taxNames[role]}.`);
  return account;
}

function dueDate(date: string, terms: number): string {
  if (!Number.isSafeInteger(terms) || terms < 0) throw unsupported('El plazo del proveedor no es válido.');
  const due = new Date(`${date}T00:00:00Z`);
  due.setUTCDate(due.getUTCDate() + terms);
  if (Number.isNaN(due.getTime()) || due.getUTCFullYear() > 9999) throw unsupported('El vencimiento del proveedor no es válido.');
  return due.toISOString().slice(0, 10);
}

function expenseDocuments(input: ExpenseInput, settings: ExpenseSettings, suppliers: Map<string, ExpenseSupplier>,
  products: Map<string, ExpenseProduct>, accounts: Map<string, ExpenseAccount>) {
  const costCenters = new Set(settings.costCenters.map(({ code }) => code));
  const groups = new Map<string, ExpenseGroup>();
  const withholding = { vatWithholding: { debit: 0, credit: 0 }, incomeWithholding: { debit: 0, credit: 0 } };
  for (const row of input.lines) {
    const supplier = suppliers.get(row.supplierCode)!;
    const product = products.get(row.productCode)!;
    if (!costCenters.has(row.costCenter)) throw unsupported(`El centro de costo ${row.costCenter} no está disponible.`);
    const productAccount = getAccount(accounts, product.accountCode, `El producto ${product.code}`);
    const base = expenseCents(row.base);
    const vat = expenseCents(row.vat);
    const vatWithholding = expenseCents(row.vatWithholding);
    const incomeWithholding = expenseCents(row.incomeWithholding);
    if (base === null || vat === null || vatWithholding === null || incomeWithholding === null) {
      throw unsupported('Los importes deben expresarse en pesos con un máximo de dos decimales.');
    }
    for (const [role, cents] of [['vatWithholding', vatWithholding], ['incomeWithholding', incomeWithholding]] as const) {
      const sign = cents < 0 ? 'debit' : 'credit';
      withholding[role][sign] = addCents(withholding[role][sign], -cents);
    }
    const groupKey = JSON.stringify([supplier.id, row.reference.toUpperCase()]);
    const group = groups.get(groupKey) ?? { supplier, reference: row.reference, lines: new Map() };
    groups.set(groupKey, group);
    const lineKey = JSON.stringify([product.id, row.costCenter]);
    const line = group.lines.get(lineKey) ?? {
      productId: product.id, productCode: product.code, productName: product.name, reference: group.reference,
      costCenter: row.costCenter, account: productAccount.code, ...zeroAmounts(),
    };
    sumAmounts(line, { base, vat, vatWithholding, incomeWithholding });
    group.lines.set(lineKey, line);
  }

  const documents: ExpenseDocument[] = [];
  const accountingLines: ExpenseAccountingLine[] = [];
  const vatByReference = new Map<string, { reference: string; cents: number }>();
  const selectedTaxes = {
    vat: selectedTaxAccount(settings, 'vat', input.taxAccounts?.vat),
    vatWithholding: selectedTaxAccount(settings, 'vatWithholding', input.taxAccounts?.vatWithholding),
    incomeWithholding: selectedTaxAccount(settings, 'incomeWithholding', input.taxAccounts?.incomeWithholding),
  };
  const postTax = (role: ExpenseTax, cents: number, reference?: string) => {
    if (!cents) return;
    const account = selectedTaxes[role];
    if (!account) throw unsupported(`Selecciona una cuenta contable para ${taxNames[role]}.`);
    accountingLines.push(accountingLine(account, cents, 0, reference));
  };
  for (const { supplier, reference, lines } of groups.values()) {
    const account = getAccount(accounts, supplier.accountCode, `El proveedor ${supplier.code}`);
    const totals = zeroAmounts();
    const documentLines: ExpenseDocumentLine[] = [];
    for (const line of lines.values()) {
      if (amountKeys.every((field) => line[field] === 0)) continue;
      sumAmounts(totals, line);
      documentLines.push({ ...line, ...fromCents(line) });
      if (line.base) accountingLines.push(accountingLine(accounts.get(line.account)!, line.base, Number(line.costCenter), supplier.name));
    }
    const total = addCents(addCents(totals.base, totals.vat), -addCents(totals.vatWithholding, totals.incomeWithholding));
    if (total <= 0) throw unsupported(`El saldo por pagar de ${supplier.code}${reference ? ` / ${reference}` : ''} debe ser positivo.`);
    accountingLines.push(accountingLine(account, -total, 0, reference));
    const vatKey = reference.toUpperCase();
    const accumulatedVat = vatByReference.get(vatKey) ?? { reference, cents: 0 };
    accumulatedVat.cents = addCents(accumulatedVat.cents, totals.vat);
    vatByReference.set(vatKey, accumulatedVat);
    documents.push({
      supplierId: supplier.id, supplierCode: supplier.code, supplierName: supplier.name,
      reference, dueDate: dueDate(input.date, supplier.terms), account, total: total / 100,
      ...fromCents(totals), lines: documentLines,
    });
  }
  for (const { reference, cents } of vatByReference.values()) postTax('vat', cents, reference);
  for (const role of ['vatWithholding', 'incomeWithholding'] as const) {
    postTax(role, withholding[role].credit);
    postTax(role, withholding[role].debit);
  }
  return { documents, accountingLines };
}

export class CreatePurchaseExpenses {
  constructor(private readonly references: ExpenseReferences, private readonly storage: ExpenseStorage) {}

  async prepare(companyId: number) {
    const settings = await this.references.settings(companyId);
    const reason = !settings ? 'No está habilitada la captura GA en esta compañía.'
      : !this.storage.writable() ? 'PostgreSQL no está configurado para registrar gastos.' : null;
    let date = dateInMexico.format();
    if (settings && date < settings.fiscalStart) date = settings.fiscalStart;
    if (settings && date > settings.fiscalEnd) date = settings.fiscalEnd;
    const defaultTaxAccounts: Partial<Record<ExpenseTax, string>> = {};
    const taxAccounts: Record<ExpenseTax, { code: string; name: string }[]> = { vat: [], vatWithholding: [], incomeWithholding: [] };
    for (const role of taxes) {
      taxAccounts[role] = settings?.taxAccounts[role].map(({ code, name }) => ({ code, name })) ?? [];
      const defaultAccount = settings?.defaultTaxAccounts[role];
      if (defaultAccount) defaultTaxAccounts[role] = defaultAccount.code;
    }
    return {
      canWrite: reason === null, reason, defaults: { date, type: 'GA' as const },
      fiscalStart: settings?.fiscalStart ?? null, fiscalEnd: settings?.fiscalEnd ?? null,
      costCenters: settings?.costCenters ?? [], taxAccounts, defaultTaxAccounts,
    };
  }

  private async supplier(companyId: number, code: string) {
    const item = await this.references.supplier(companyId, code);
    if (!item) throw new NotFoundError(`Proveedor ${code} elegible para GA`);
    return item;
  }

  private async product(code: string) {
    const item = await this.references.product(code);
    if (!item) throw new NotFoundError(`Producto de gasto ${code}`);
    return item;
  }

  async catalog(companyId: number, supplierCode?: string, productCode?: string) {
    const [supplier, product, settings] = await Promise.all([
      supplierCode ? this.supplier(companyId, supplierCode) : null,
      productCode ? this.product(productCode) : null,
      supplierCode ? this.references.settings(companyId) : null,
    ]);
    return {
      ...(supplier ? { supplier: {
        id: supplier.id, code: supplier.code, name: supplier.name, vatRate: settings?.vatRates[supplier.vatType] ?? 0,
        vatWithholdingRate: supplier.vatWithholdingRate, incomeWithholdingRate: supplier.incomeWithholdingRate,
        calculateTaxes: Boolean(settings && supplier.vatType <= 1),
      } } : {}),
      ...(product ? { product: {
        id: product.id, code: product.code, name: product.name, vatExempt: product.vatExempt,
        retentionsEligible: product.retentionsEligible,
      } } : {}),
    };
  }

  async save(actor: ExpenseActor, input: ExpenseInput) {
    if (!this.storage.writable()) throw new ApplicationError('PostgreSQL no está configurado para registrar gastos.', 'PURCHASE_EXPENSE_POSTGRES_UNAVAILABLE', 503);
    const { requestKey, ...fields } = input;
    const fingerprint = createHash('sha256').update(JSON.stringify(fields)).digest('hex');
    const replay = await this.storage.findRequest(actor.companyId, requestKey, fingerprint);
    if (replay) return replay;
    const settings = await this.references.settings(actor.companyId);
    if (!settings) throw unsupported('No está habilitada la captura GA en esta compañía.');
    if (input.date < settings.fiscalStart || input.date > settings.fiscalEnd) {
      throw unsupported(`La fecha del gasto debe estar entre ${settings.fiscalStart} y ${settings.fiscalEnd}.`);
    }
    const [supplierEntries, productEntries, existing] = await Promise.all([
      Promise.all([...new Set(input.lines.map(({ supplierCode }) => supplierCode))].map(async (code) => [code, await this.supplier(actor.companyId, code)] as const)),
      Promise.all([...new Set(input.lines.map(({ productCode }) => productCode))].map(async (code) => [code, await this.product(code)] as const)),
      this.references.existingReference([...new Set(input.lines.map(({ reference }) => reference).filter(Boolean))]),
    ]);
    if (existing) throw new ConflictError(`Ya existe un documento con la referencia ${existing}.`, 'PURCHASE_EXPENSE_REFERENCE_CONFLICT');
    const accounts = await this.references.accounts(actor.companyId, [...supplierEntries, ...productEntries].map(([, item]) => item.accountCode));
    const posting = expenseDocuments(input, settings, new Map(supplierEntries), new Map(productEntries), accounts);
    return this.storage.commit({ actor, input, fingerprint, ...posting });
  }
}
