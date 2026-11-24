import { createHash } from 'node:crypto';
import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import { ConflictError } from '../../../../../shared/domain/errors/conflict-error.js';
import { NotFoundError } from '../../../../../shared/domain/errors/not-found-error.js';
import type {
  SupplierPaymentCommand, SupplierPaymentDataSource, SupplierPaymentIdentity, SupplierPaymentInput, SupplierPaymentReferences, SupplierPaymentSettings,
} from '../../domain/datasources/supplier-payment-data-source.js';
import { supplierPaymentReason } from '../../domain/entities/supplier-payment.js';

const mexicoDate = new Intl.DateTimeFormat('sv-SE', { dateStyle: 'short', timeZone: 'America/Mexico_City' });
const settingsUnavailable = 'No se encontraron el tipo PP, la póliza de egresos o la cuenta contable del proveedor.';
const bankUnavailable = 'No se encontró un banco habilitado para pagos en pesos.';
const postgresUnavailable = () =>
  new ApplicationError('El registro de pagos de proveedor requiere PostgreSQL.', 'SUPPLIER_PAYMENT_POSTGRES_UNAVAILABLE', 503);

export class CaptureSupplierPayment {
  constructor(
    private readonly storage: SupplierPaymentDataSource,
    private readonly references: SupplierPaymentReferences,
  ) {}

  private async target(identity: SupplierPaymentIdentity) {
    if (!this.storage.writable()) throw postgresUnavailable();
    const target = await this.storage.target(identity);
    if (!target) throw new NotFoundError('Documento local del proveedor');
    return target;
  }

  private bankAccounts(settings: SupplierPaymentSettings | null) {
    return settings?.bankAccounts.filter(({ code }) => code !== settings.supplierAccount) ?? [];
  }

  async prepare(identity: SupplierPaymentIdentity) {
    const target = await this.target(identity);
    const reason = supplierPaymentReason(target);
    const settings = reason ? null : await this.references.settings(identity.companyId, identity.supplierId, undefined, undefined, target.liability);
    const bankAccounts = this.bankAccounts(settings);
    const unavailable = reason ?? (!settings ? settingsUnavailable : bankAccounts.length === 0 ? bankUnavailable : null);
    return {
      receiptId: target.receiptId,
      number: target.number,
      remaining: target.remaining,
      revision: target.revision,
      canWrite: unavailable === null,
      reason: unavailable,
      bankAccounts,
      defaults: { date: mexicoDate.format(), amount: target.remaining, mode: 'transfer' as const },
    };
  }

  async save(identity: SupplierPaymentIdentity, userId: number, raw: SupplierPaymentInput) {
    if (!this.storage.writable()) throw postgresUnavailable();
    const input = { ...raw, requestKey: raw.requestKey.toLowerCase() };
    const fingerprint = createHash('sha256').update(JSON.stringify({
      ...identity,
      userId,
      revision: input.revision,
      bankAccountId: input.bankAccountId,
      mode: input.mode,
      date: input.date,
      amount: input.amount,
      description: input.description,
    })).digest('hex');
    const previous = await this.storage.findRequest(identity.companyId, input.requestKey, fingerprint);
    if (previous) return previous;

    const target = await this.target(identity);
    const resolvePosting: SupplierPaymentCommand['resolvePosting'] = async (lookup, catalog, liability = target.liability) => {
      const settings = await this.references.settings(identity.companyId, identity.supplierId, input.bankAccountId, lookup, liability, catalog);
      if (!settings) throw new ConflictError(settingsUnavailable, 'SUPPLIER_PAYMENT_CONFIG_UNAVAILABLE');
      const bank = this.bankAccounts(settings).find(({ id }) => id === input.bankAccountId);
      if (!bank) throw new ConflictError(bankUnavailable, 'SUPPLIER_PAYMENT_BANK_UNAVAILABLE');
      return { policyType: settings.policyType, supplierAccount: settings.supplierAccount, supplierAccountName: settings.supplierAccountName, bank };
    };
    return this.storage.commit({ identity, userId, input, fingerprint, resolvePosting });
  }
}
