import type { ClientFiscalVerificationProvider, FiscalProviderResult } from '../../domain/services/client-fiscal-verification-provider.js';

export class UnconfiguredClientFiscalVerificationProvider implements ClientFiscalVerificationProvider {
  readonly configured = false;

  async verify(): Promise<FiscalProviderResult> {
    return { status: 'unavailable', reason: 'not-configured' };
  }
}
