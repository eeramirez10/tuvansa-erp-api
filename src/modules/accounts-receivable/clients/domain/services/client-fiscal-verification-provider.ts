import type { FiscalValues } from '../entities/client-fiscal.js';

// Internal contract, derived for the API; not a confirmed vendor protocol.
export type FiscalProviderResult =
  | { status: 'validated' }
  | { status: 'rejected' }
  | { status: 'unavailable'; reason: 'not-configured' | 'temporary' };

export interface ClientFiscalVerificationProvider {
  readonly configured: boolean;
  // Adapters validate vendor responses, enforce a timeout, and never return raw credentials/errors.
  // Validation of these values does not calculate or authorize an OMNIS legacy marker.
  verify(values: Readonly<FiscalValues>): Promise<FiscalProviderResult>;
}
