import { BankAccount, type BankAccountProps } from './bank-account.js';

export type BankCatalogFields = Pick<BankAccountProps,
  'code' | 'family' | 'accountNumber' | 'branch' | 'name' | 'nature' | 'systemType' | 'control' | 'prorationPercentages'
> & { currencyId: number };

export interface BankCatalogSnapshot {
  id: number;
  legacy: boolean;
  fields: BankCatalogFields;
  revision: number;
  createdOn: string;
  archived?: boolean;
}

export const bankCatalogCurrencies = [
  { id: 0, name: 'Predeterminada' }, { id: 1, name: 'Pesos' }, { id: 2, name: 'Dólares' },
] as const;
export const bankCatalogNatures = [
  { id: 'debtor', name: 'Deudora' }, { id: 'creditor', name: 'Acreedora' },
] as const;
export const bankCatalogSystemTypes = [
  { id: 'bank', name: 'Banco' }, { id: 'expense', name: 'Gastos' }, { id: 'other', name: 'Otro' },
] as const;

const editableControl = [
  'manager', 'phone', 'customerNumber', 'controlEnabled', 'preventJournalEntries',
  'format', 'budgetable', 'company', 'deposits', 'payments', 'multiCompany',
] as const satisfies readonly (keyof BankCatalogFields['control'])[];

export const bankCatalogEditableFields = [
  'family', 'accountNumber', 'branch', 'name', 'nature', 'systemType', 'currencyId',
  ...editableControl.map((field) => `control.${field}`),
  'prorationPercentages.sales', 'prorationPercentages.inventory', 'prorationPercentages.distribution', 'prorationPercentages.advance',
];

export function bankCatalogDefaults(): BankCatalogFields {
  return {
    code: '', family: '', accountNumber: '', branch: '', name: '', nature: 'debtor', systemType: 'other', currencyId: 0,
    control: {
      manager: '', phone: '', customerNumber: '0', controlEnabled: false, nextCheckNumber: 0, nextDepositNumber: 0,
      nextTransferNumber: 0, subAccounts: false, preventJournalEntries: false, format: '', movements: false,
      budgetable: false, company: 0, deposits: false, payments: false, multiCompany: 0,
    },
    prorationPercentages: { sales: 0, inventory: 0, distribution: 0, advance: 0 },
  };
}

export function bankCatalogFields(account: BankAccount): BankCatalogFields {
  const { code, family, accountNumber, branch, name, nature, systemType, currency, control, prorationPercentages } = account.toPrimitives();
  return { code, family, accountNumber, branch, name, nature, systemType, currencyId: currency.id, control, prorationPercentages };
}

function localBase(snapshot: BankCatalogSnapshot): BankAccountProps {
  const { currencyId, ...fields } = snapshot.fields;
  const months = () => Array.from({ length: 12 }, (_, index) => ({ month: index + 1, balance: 0, charges: 0, credits: 0, budget: 0 }));
  return {
    ...fields, id: snapshot.id, createdAt: snapshot.createdOn,
    currency: { id: currencyId, name: currencyId === 2 ? 'DOLARES' : 'PESOS' },
    balances: { current: 0, bank: 0, previous: 0, inTransit: 0 },
    currencyBalances: { current: 0, month12: 0, previous: 0 },
    fiscalReports: { annualInflationAdjustment: 0, deductibleIetu: false, nonDeductibleVat: false },
    ledger: { firstPeriod: months(), secondPeriod: months() },
  };
}

export function projectBankCatalog(
  legacy: BankAccount | null, snapshot: BankCatalogSnapshot | null, hasLocalChildren: boolean,
): BankAccount | null {
  if (snapshot?.archived) return null;
  const baseline = legacy?.toPrimitives() ?? (snapshot && !snapshot.legacy ? localBase(snapshot) : null);
  if (!baseline) return null;
  if (!snapshot && !hasLocalChildren) return legacy;

  const stored = snapshot?.fields;
  const currencyId = stored?.currencyId ?? baseline.currency.id;
  return BankAccount.create({
    ...baseline,
    ...(stored ? {
      code: stored.code, family: stored.family, accountNumber: stored.accountNumber, branch: stored.branch, name: stored.name,
      nature: stored.nature, systemType: stored.systemType, prorationPercentages: stored.prorationPercentages,
      currency: { id: currencyId, name: currencyId === 2 ? 'DOLARES' : 'PESOS' },
    } : {}),
    control: {
      ...baseline.control, ...stored?.control,
      subAccounts: baseline.control.subAccounts || hasLocalChildren,
      movements: baseline.control.movements,
      nextCheckNumber: baseline.control.nextCheckNumber,
      nextDepositNumber: baseline.control.nextDepositNumber,
      nextTransferNumber: baseline.control.nextTransferNumber,
    },
  });
}
