import { createHash } from 'node:crypto';
import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import { ConflictError } from '../../../../../shared/domain/errors/conflict-error.js';
import { NotFoundError } from '../../../../../shared/domain/errors/not-found-error.js';
import type {
  PostingReversalDataSource, PostingReversalFiscalWindow, PostingReversalInput, PostingReversalReferences,
  PostingReversalSnapshot, PostingReversalTarget,
} from '../../domain/datasources/purchase-posting-reversal-data-source.js';

const mexicoDate = new Intl.DateTimeFormat('sv-SE', { dateStyle: 'short', timeZone: 'America/Mexico_City' });
const invalidDate = (message: string) => new ApplicationError(message, 'POSTING_REVERSAL_INVALID_DATE', 422);

function periodReason(snapshot: PostingReversalSnapshot, period: PostingReversalFiscalWindow | null) {
  if (!period) return 'No está configurado el periodo contable de la compañía.';
  if (snapshot.originalDate < period.fiscalStart || snapshot.originalDate > period.fiscalEnd) {
    return 'La fecha del registro original queda fuera del periodo contable activo.';
  }
  if (snapshot.minimumDate > period.fiscalEnd) {
    return snapshot.originalReconciliation ? 'El corte bancario queda fuera del periodo contable activo.'
      : 'La última reversión PP de la póliza queda fuera del periodo contable activo.';
  }
  return null;
}

function alreadyRecordedReason(target: PostingReversalTarget) {
  return target.kind === 'payment' ? 'El pago ya fue revertido.' : 'La póliza de gastos ya fue cancelada.';
}

export class ReversePurchasePosting {
  constructor(private readonly dataSource: PostingReversalDataSource, private readonly references: PostingReversalReferences) {}

  private async snapshot(companyId: number, target: PostingReversalTarget) {
    const snapshot = await this.dataSource.snapshot(companyId, target);
    if (!snapshot) throw new NotFoundError(target.kind === 'payment' ? 'Pago PP registrado en la web' : 'Gasto GA registrado en la web');
    return snapshot;
  }

  async prepare(companyId: number, target: PostingReversalTarget) {
    const [snapshot, period] = await Promise.all([this.snapshot(companyId, target), this.references.fiscalWindow(companyId)]);
    const { number, policyNumber, originalDate, amount, documents, alreadyRecorded, blocked } = snapshot;
    const reason = alreadyRecorded ? alreadyRecordedReason(target) : blocked ?? periodReason(snapshot, period);
    let date = mexicoDate.format();
    if (date < snapshot.minimumDate) date = snapshot.minimumDate;
    if (period && date < period.fiscalStart) date = period.fiscalStart;
    if (period && date > period.fiscalEnd) date = period.fiscalEnd;
    return {
      canWrite: reason === null, reason, number, policyNumber, date: alreadyRecorded?.date ?? date, originalDate,
      minimumDate: snapshot.minimumDate,
      fiscalStart: period?.fiscalStart ?? null, fiscalEnd: period?.fiscalEnd ?? null, amount, documents, alreadyRecorded,
      ...(target.kind === 'payment' ? {
        originalReconciliation: snapshot.originalReconciliation ?? null,
        notice: snapshot.originalReconciliation
          ? 'El pago original conserva su corte. El cargo de la reversión quedará pendiente de conciliación.' : null,
      } : {}),
    };
  }

  async save(actor: { companyId: number; userId: number }, target: PostingReversalTarget, input: PostingReversalInput) {
    const snapshot = await this.snapshot(actor.companyId, target);
    const fields: (string | number)[] = [target.kind, snapshot.targetId, input.date, input.reason];
    if (target.kind === 'payment' && input.expectedReconciliationId != null) fields.push(input.expectedReconciliationId);
    const fingerprint = createHash('sha256').update(JSON.stringify(fields)).digest('hex');
    const replay = await this.dataSource.findRequest(actor.companyId, target, input.requestKey, fingerprint);
    if (replay) return replay;
    const period = await this.references.fiscalWindow(actor.companyId);
    const validate = (current: PostingReversalSnapshot) => {
      if (current.alreadyRecorded) throw new ConflictError(alreadyRecordedReason(target), 'POSTING_REVERSAL_ALREADY_RECORDED');
      if (current.blocked) throw new ConflictError(current.blocked, 'POSTING_REVERSAL_BLOCKED');
      if (target.kind === 'payment' && (current.originalReconciliation?.id ?? null) !== (input.expectedReconciliationId ?? null)) {
        throw new ConflictError('El estado de conciliación cambió. Vuelve a abrir la reversión y revisa el corte.', 'POSTING_REVERSAL_RECONCILIATION_CHANGED');
      }
      const reason = periodReason(current, period);
      if (reason) throw invalidDate(reason);
      if (!period || input.date < period.fiscalStart || input.date > period.fiscalEnd || input.date < current.originalDate) {
        throw invalidDate('La fecha debe estar en el periodo contable activo y ser igual o posterior a la fecha original.');
      }
      if (input.date < current.minimumDate) {
        const reference = current.originalReconciliation ? 'al último corte bancario' : 'a la última reversión PP';
        throw invalidDate(`La fecha debe ser igual o posterior ${reference} (${current.minimumDate}).`);
      }
    };
    validate(snapshot);
    return this.dataSource.commit({ actor, target, input, fingerprint, validate });
  }
}
