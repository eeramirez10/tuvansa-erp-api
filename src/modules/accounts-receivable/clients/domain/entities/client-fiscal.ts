export interface FiscalValues {
  taxId: string;
  name: string;
  postalCode: string;
  fiscalRegime: string;
}

export interface CapitalRegime { code: string; description: string }

export interface ClientFiscal {
  clientId: number;
  code: string;
  values: FiscalValues;
  version: string;
  verification: 'legacy-marker-present' | 'pending';
  capitalRegimes: CapitalRegime[];
  verificationAvailable: boolean;
}

export interface SaveClientFiscal {
  values: FiscalValues;
  expectedVersion: string;
}

export type FiscalSaveResult =
  | { status: 'saved'; data: ClientFiscal }
  | { status: 'not-found' | 'conflict' };
