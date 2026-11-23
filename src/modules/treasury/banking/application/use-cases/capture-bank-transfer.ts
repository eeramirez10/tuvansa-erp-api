import { createHash } from 'node:crypto';
import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import { ConflictError } from '../../../../../shared/domain/errors/conflict-error.js';
import { NotFoundError } from '../../../../../shared/domain/errors/not-found-error.js';
import type { BankTransferDataSource, BankTransferInput, BankTransferReferences } from '../../domain/datasources/bank-transfer-data-source.js';
import { bankTransferAccount, canTransfer, validateBankTransferInput } from '../../domain/entities/bank-transfer.js';

const mexicoDate = new Intl.DateTimeFormat('sv-SE', { dateStyle: 'short', timeZone: 'America/Mexico_City' });
const unavailable = 'La configuración de póliza de diario de México no está disponible para traspasos.';
const invalidDestination = 'La cuenta destino no admite registros de traspaso en pesos.';
const invalidSource = 'La cuenta de origen no admite registros de traspaso en pesos.';

export class CaptureBankTransfer {
  constructor(
    private readonly storage: BankTransferDataSource,
    private readonly references: BankTransferReferences,
  ) {}

  async prepare(companyId: number, destinationAccountId: number) {
    const [destination, settings] = await Promise.all([
      this.references.account(destinationAccountId), this.references.settings(companyId),
    ]);
    if (!destination) throw new NotFoundError('Cuenta destino');
    let reason: string | null = null;
    let sources: ReturnType<typeof bankTransferAccount>[] = [];
    if (!this.storage.writable()) reason = 'El registro de traspasos requiere PostgreSQL.';
    else if (!settings) reason = unavailable;
    else if (!canTransfer(destination, companyId, 'destination')) reason = invalidDestination;
    else {
      const accounts = await this.references.sources(companyId);
      sources = accounts.filter((account) => account.id !== destinationAccountId && account.code !== destination.code
        && canTransfer(account, companyId, 'source'))
        .map(bankTransferAccount);
      if (!sources.length) reason = 'No hay otra cuenta bancaria habilitada en pesos.';
    }
    return {
      destination: bankTransferAccount(destination), sources, canWrite: reason === null, reason,
      defaults: { date: mexicoDate.format() }, fiscalStart: settings?.fiscalStart ?? '', fiscalEnd: settings?.fiscalEnd ?? '',
    };
  }

  async save(companyId: number, userId: number, destinationAccountId: number, raw: BankTransferInput) {
    if (!this.storage.writable()) {
      throw new ApplicationError('El registro de traspasos requiere PostgreSQL.', 'BANK_TRANSFER_POSTGRES_UNAVAILABLE', 503);
    }
    const input = {
      ...raw, requestKey: raw.requestKey.toLowerCase(), reference: raw.reference.trim(),
      beneficiary: raw.beneficiary.trim(), description: raw.description.trim(),
    };
    validateBankTransferInput(input, destinationAccountId);
    const fingerprint = createHash('sha256').update(JSON.stringify({
      companyId, userId, destinationAccountId, sourceBankAccountId: input.sourceBankAccountId, date: input.date,
      amount: input.amount, reference: input.reference, beneficiary: input.beneficiary, description: input.description,
    })).digest('hex');
    const previous = await this.storage.findRequest(companyId, input.requestKey, fingerprint);
    if (previous) return previous;

    return this.storage.commit({
      companyId, userId, destinationAccountId, input, fingerprint,
      resolvePosting: async (lookup = (id) => this.references.account(id)) => {
        const settings = await this.references.settings(companyId);
        if (!settings) throw new ConflictError(unavailable, 'BANK_TRANSFER_CONFIG_UNAVAILABLE');
        const destination = await lookup(destinationAccountId);
        if (!destination || !canTransfer(destination, companyId, 'destination')) {
          throw new ConflictError(invalidDestination, 'BANK_TRANSFER_DESTINATION_UNAVAILABLE');
        }
        const source = await lookup(input.sourceBankAccountId);
        if (!source || !canTransfer(source, companyId, 'source') || source.code === destination.code) {
          throw new ConflictError(invalidSource, 'BANK_TRANSFER_SOURCE_UNAVAILABLE');
        }
        if (input.date < settings.fiscalStart || input.date > settings.fiscalEnd) {
          throw new ApplicationError('La fecha del traspaso está fuera del periodo autorizado de trabajo.', 'BANK_TRANSFER_INVALID_DATE', 422);
        }
        return { source: bankTransferAccount(source), destination: bankTransferAccount(destination), settings };
      },
    });
  }
}
