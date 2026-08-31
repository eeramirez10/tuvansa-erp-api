export type BankPanelKey =
  | 'movements'
  | 'deposits'
  | 'payments'
  | 'auxiliary'
  | 'reconciliation'
  | 'automatic-reconciliation'
  | 'general-ledger'
  | 'cost-center-ledger'
  | 'authorization-review'
  | 'classifiers'
  | 'supplier-expenses'
  | 'transfer'
  | 'unapplied-auxiliary';

export interface BankPanelOptions {
  fiscalYear: number;
  costCenter: string;
  asOfDate: string;
}

export interface BankPanelResponse {
  button: string;
  section: 'actions';
  source: string[];
  available: boolean;
  readOnly: true;
  items: unknown[];
  summary?: Record<string, unknown>;
  reason?: string;
}

export interface BankPanelsRepository {
  getPanel(bankAccountId: number, key: BankPanelKey, options: BankPanelOptions): Promise<BankPanelResponse>;
}
