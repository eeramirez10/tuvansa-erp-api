export type ExpenseCatalogEntry = { code: string; name: string };
export type ExpenseAccount = ExpenseCatalogEntry & { id: number };
export type ExpenseTax = 'vat' | 'vatWithholding' | 'incomeWithholding';

export interface ExpenseSettings {
  fiscalStart: string;
  fiscalEnd: string;
  vatRates: [number, number, number];
  costCenters: ExpenseCatalogEntry[];
  taxAccounts: Record<ExpenseTax, ExpenseAccount[]>;
  defaultTaxAccounts: Record<ExpenseTax, ExpenseAccount | null>;
}

export interface ExpenseSupplier {
  id: number;
  code: string;
  name: string;
  vatType: number;
  vatWithholdingRate: number;
  incomeWithholdingRate: number;
  terms: number;
  accountCode: string;
}

export interface ExpenseProduct {
  id: number;
  code: string;
  name: string;
  vatExempt: boolean;
  retentionsEligible: boolean;
  accountCode: string;
}

export interface ExpenseReferences {
  settings(companyId: number): Promise<ExpenseSettings | null>;
  supplier(companyId: number, code: string): Promise<ExpenseSupplier | null>;
  product(code: string): Promise<ExpenseProduct | null>;
  accounts(companyId: number, codes: string[]): Promise<Map<string, ExpenseAccount>>;
  existingReference(references: string[]): Promise<string | null>;
}

export interface ExpenseAmounts {
  base: number;
  vat: number;
  vatWithholding: number;
  incomeWithholding: number;
}

export interface ExpenseInput {
  requestKey: string;
  date: string;
  reference: string;
  beneficiary: string;
  description: string;
  taxAccounts?: Partial<Record<ExpenseTax, string>> | undefined;
  lines: Array<ExpenseAmounts & { supplierCode: string; productCode: string; reference: string; costCenter: string }>;
}

export interface ExpenseDocumentLine extends ExpenseAmounts {
  productId: number;
  productCode: string;
  productName: string;
  reference: string;
  costCenter: string;
  account: string;
}

export interface ExpenseDocumentSummary {
  id: number;
  number: string;
  supplierId: number;
  supplierCode: string;
  supplierName: string;
  reference: string;
  total: number;
}

export interface ExpenseDocument extends ExpenseAmounts, Omit<ExpenseDocumentSummary, 'id' | 'number'> {
  dueDate: string;
  account: ExpenseAccount;
  lines: ExpenseDocumentLine[];
}

export interface ExpenseAccountingLine {
  account: string;
  accountId: number;
  accountName: string;
  department: number;
  debit: number;
  credit: number;
  reference?: string;
}

export interface ExpenseActor { companyId: number; userId: number }

export interface ExpenseResult {
  id: number;
  policyNumber: string;
  documents: ExpenseDocumentSummary[];
}

export interface ExpensePosting {
  actor: ExpenseActor;
  input: ExpenseInput;
  fingerprint: string;
  documents: ExpenseDocument[];
  accountingLines: ExpenseAccountingLine[];
}

export interface ExpenseStorage {
  writable(): boolean;
  findRequest(companyId: number, requestKey: string, fingerprint: string): Promise<ExpenseResult | null>;
  commit(posting: ExpensePosting): Promise<ExpenseResult>;
}
