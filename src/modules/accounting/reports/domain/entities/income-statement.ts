export interface IncomeStatementCriteria { month: number; level: number; accounts: '8' }
export interface IncomeStatementSettings {
  companyName: string; companyLegalName: string; fiscalStart: string; fiscalEnd: string;
  levelLengths: number[];
}
export interface IncomeStatementAccount {
  id: number; code: string; name: string; nature: number;
  balance: number; debit: number; credit: number;
}
export type IncomeStatementRowKind = 'section' | 'group' | 'account' | 'subtotal' | 'section-total' | 'result';
export interface IncomeStatementRow {
  key: string; code: string; label: string; depth: number; kind: IncomeStatementRowKind;
  month: number | null; accumulated: number | null;
}
export interface IncomeStatement {
  title: string; companyName: string; companyLegalName: string; generatedAt: string; asOf: string;
  criteria: IncomeStatementCriteria; rows: IncomeStatementRow[];
  totals: { month: number; accumulated: number }; empty: boolean;
  financial?: FinancialIncomeStatement;
}
export interface IncomeStatementOptions extends IncomeStatementSettings {
  months: Array<{ value: number; label: string; asOf: string }>;
  levels: Array<{ value: number; codeLength: number }>;
  defaultMonth: number; defaultLevel: number;
}


export interface FinancialIncomeStatementRow {
  key: string;
  label: string;
  kind: 'detail' | 'total' | 'result' | 'spacer';
  month: number | null;
  accumulated: number | null;
  monthPercent: number | null;
  accumulatedPercent: number | null;
  sourceCodes: string[];
}

export interface FinancialIncomeStatement {
  scopeLabel: string;
  rows: FinancialIncomeStatementRow[];
  notices: string[];
  reconciliation: {
    month: number;
    accumulated: number;
    differenceMonth: number;
    differenceAccumulated: number;
  };
}
