import { createHash } from 'node:crypto';
import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import { ConflictError } from '../../../../../shared/domain/errors/conflict-error.js';
import { NotFoundError } from '../../../../../shared/domain/errors/not-found-error.js';
import type {
  CustomerCollectionDataSource, CustomerCollectionIdentity, CustomerCollectionInput,
  CustomerCollectionReferences, CustomerCollectionSettings,
} from '../../domain/datasources/customer-collection-data-source.js';
import { collectionReason } from '../../domain/entities/customer-collection.js';

const mexicoDate = new Intl.DateTimeFormat('sv-SE', { dateStyle: 'short', timeZone: 'America/Mexico_City' });
const configurationMissing = 'No se encontró el tipo PA, la póliza de ingresos o la cuenta contable del cliente.';
const bankMissing = 'Selecciona una cuenta bancaria habilitada para depósitos en pesos.';

export class CaptureCustomerCollection {
  constructor(
    private readonly storage: CustomerCollectionDataSource,
    private readonly references: CustomerCollectionReferences,
  ) {}

  private ensureWritable() {
    if (!this.storage.writable()) {
      throw new ApplicationError('El registro de cobranza requiere PostgreSQL.', 'CUSTOMER_COLLECTION_POSTGRES_UNAVAILABLE', 503);
    }
  }

  private async target(identity: CustomerCollectionIdentity) {
    const target = await this.storage.target(identity);
    if (!target) throw new NotFoundError('Remisión web del cliente');
    return target;
  }

  private banks(settings: CustomerCollectionSettings | null) {
    return settings?.bankAccounts.filter(({ code }) => code !== settings.clientAccount) ?? [];
  }

  async prepare(identity: CustomerCollectionIdentity) {
    this.ensureWritable();
    const target = await this.target(identity);
    const reason = collectionReason(target);
    const settings = reason ? null : await this.references.settings(identity.companyId, identity.clientId);
    const bankAccounts = this.banks(settings);
    const unavailable = reason ?? (!settings ? configurationMissing : bankAccounts.length === 0 ? bankMissing : null);
    const defaultsDate = [mexicoDate.format(), target.issuedAt, target.lastReversalDate ?? ''].sort().at(-1)!;
    return {
      remissionId: target.remissionId, number: target.number, remaining: target.remaining, revision: target.revision,
      canWrite: unavailable === null, reason: unavailable, bankAccounts,
      defaults: { date: defaultsDate, amount: target.remaining },
    };
  }

  async save(identity: CustomerCollectionIdentity, userId: number, raw: CustomerCollectionInput) {
    this.ensureWritable();
    const input = { ...raw, requestKey: raw.requestKey.toLowerCase() };
    const fingerprint = createHash('sha256').update(JSON.stringify({
      ...identity, userId, revision: input.revision, bankAccountId: input.bankAccountId, amount: input.amount,
      date: input.date, description: input.description, reference: input.reference,
    })).digest('hex');
    const existing = await this.storage.findRequest(identity.companyId, input.requestKey, fingerprint);
    if (existing) return existing;

    await this.target(identity);
    return this.storage.commit({
      identity, input, userId, fingerprint,
      resolvePosting: async () => {
        const settings = await this.references.settings(identity.companyId, identity.clientId);
        if (!settings) throw new ConflictError(configurationMissing, 'CUSTOMER_COLLECTION_CONFIG_UNAVAILABLE');
        const bank = this.banks(settings).find(({ id }) => id === input.bankAccountId);
        if (!bank) throw new ConflictError(bankMissing, 'CUSTOMER_COLLECTION_BANK_UNAVAILABLE');
        if (input.date < settings.fiscalStart || input.date > settings.fiscalEnd) {
          throw new ApplicationError('La fecha de cobro debe estar dentro del período fiscal de México.', 'CUSTOMER_COLLECTION_DATE_INVALID', 422);
        }
        const { clientAccount, clientAccountName, policyType } = settings;
        return { bank, clientAccount, clientAccountName, policyType };
      },
    });
  }
}
