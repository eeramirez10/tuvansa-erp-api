import { createHash } from 'node:crypto';
import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import { ConflictError } from '../../../../../shared/domain/errors/conflict-error.js';
import { NotFoundError } from '../../../../../shared/domain/errors/not-found-error.js';
import type { PostingReversalFiscalWindow, PostingReversalReferences } from '../../../../purchasing/purchase-receptions/domain/datasources/purchase-posting-reversal-data-source.js';
import type {
  CustomerCollectionReversalDataSource, CustomerCollectionReversalIdentity, CustomerCollectionReversalInput, CustomerCollectionReversalSource,
} from '../../domain/datasources/customer-collection-reversal-data-source.js';

const dateInMexico = new Intl.DateTimeFormat('sv-SE', { dateStyle: 'short', timeZone: 'America/Mexico_City' });
const invalidDate = (reason: string) => new ApplicationError(reason, 'CUSTOMER_COLLECTION_REVERSAL_INVALID_DATE', 422);

function blocked(source: CustomerCollectionReversalSource) {
  if (source.alreadyRecorded) return 'El cobro PA ya fue revertido.';
  if (!source.supported) return 'El cobro requiere una reversión contable distinta.';
  return null;
}

const minimumDate = (source: CustomerCollectionReversalSource) => [source.originalDate, source.originalReconciliation?.date ?? '',
  source.latestBankStatementDate ?? '', source.lastCollectionReversalAt ?? ''].sort().at(-1)!;

function periodReason(source: CustomerCollectionReversalSource, fiscal: PostingReversalFiscalWindow | null) {
  if (!fiscal) return 'No está configurado el periodo contable de la compañía.';
  if (source.originalDate < fiscal.fiscalStart || source.originalDate > fiscal.fiscalEnd) return 'El cobro original queda fuera del periodo contable activo.';
  if (minimumDate(source) > fiscal.fiscalEnd) return 'El último corte o reversión posterior al cobro queda fuera del periodo contable activo.';
  return null;
}

export class ReverseCustomerCollection {
  constructor(private readonly dataSource: CustomerCollectionReversalDataSource, private readonly fiscal: PostingReversalReferences) {}

  private async source(identity: CustomerCollectionReversalIdentity) {
    const source = await this.dataSource.source(identity);
    if (!source) throw new NotFoundError('Cobro PA registrado en la web');
    return source;
  }

  async prepare(identity: CustomerCollectionReversalIdentity) {
    const [source, fiscal] = await Promise.all([this.source(identity), this.fiscal.fiscalWindow(identity.companyId)]);
    const { number, policyNumber, originalDate, amount, remissionId, remissionNumber, principal, alreadyRecorded, originalReconciliation } = source;
    const reason = blocked(source) ?? periodReason(source, fiscal);
    const earliest = minimumDate(source);
    let date = dateInMexico.format();
    if (date < earliest) date = earliest;
    if (fiscal && date < fiscal.fiscalStart) date = fiscal.fiscalStart;
    if (fiscal && date > fiscal.fiscalEnd) date = fiscal.fiscalEnd;
    return { canWrite: !reason, reason, number, policyNumber, originalDate, date: alreadyRecorded?.date ?? date,
      fiscalStart: fiscal?.fiscalStart ?? null, fiscalEnd: fiscal?.fiscalEnd ?? null, amount,
      documents: [{ id: remissionId, number: remissionNumber, total: principal }], alreadyRecorded,
      minimumDate: earliest, originalReconciliation,
      notice: originalReconciliation ? 'El cobro conserva su corte original. La corrección quedará como egreso pendiente de conciliación.' : null };
  }

  async save(identity: CustomerCollectionReversalIdentity, userId: number, input: CustomerCollectionReversalInput) {
    const fields: (number | string)[] = [identity.clientId, identity.collectionId, input.date, input.reason];
    if (input.expectedReconciliationId != null) fields.push(input.expectedReconciliationId);
    const fingerprint = createHash('sha256').update(JSON.stringify(fields)).digest('hex');
    const previous = await this.dataSource.findRequest(identity.companyId, input.requestKey, fingerprint);
    if (previous) return previous;
    const [source, fiscal] = await Promise.all([this.source(identity), this.fiscal.fiscalWindow(identity.companyId)]);
    const validate = (current: CustomerCollectionReversalSource) => {
      const reason = blocked(current);
      if (reason) throw new ConflictError(reason, current.alreadyRecorded ? 'CUSTOMER_COLLECTION_REVERSAL_ALREADY_RECORDED' : 'CUSTOMER_COLLECTION_REVERSAL_BLOCKED');
      if ((current.originalReconciliation?.id ?? null) !== (input.expectedReconciliationId ?? null)) {
        throw new ConflictError('El estado de conciliación cambió. Vuelve a abrir la reversión y revisa el corte.', 'CUSTOMER_COLLECTION_REVERSAL_RECONCILIATION_CHANGED');
      }
      const invalidPeriod = periodReason(current, fiscal);
      if (invalidPeriod) throw invalidDate(invalidPeriod);
      if (!fiscal || input.date < current.originalDate || input.date < fiscal.fiscalStart || input.date > fiscal.fiscalEnd) {
        throw invalidDate('La fecha debe estar en el periodo contable activo y ser igual o posterior al cobro original.');
      }
      if (input.date < minimumDate(current)) throw invalidDate(`La fecha debe ser igual o posterior al corte o reversión más reciente (${minimumDate(current)}).`);
    };
    validate(source);
    return this.dataSource.commit({ identity, userId, input, fingerprint, validate });
  }
}
