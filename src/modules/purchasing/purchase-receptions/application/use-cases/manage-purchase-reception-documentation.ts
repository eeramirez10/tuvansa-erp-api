import { createHash } from 'node:crypto';
import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import { ConflictError } from '../../../../../shared/domain/errors/conflict-error.js';
import { NotFoundError } from '../../../../../shared/domain/errors/not-found-error.js';
import type {
  PurchaseReceptionDocumentationDataSource, ReceptionDocumentationInput, ReceptionDocumentationSource,
} from '../../domain/datasources/purchase-reception-documentation-data-source.js';
import type { PurchaseReceptionActor } from '../../domain/datasources/purchase-reception-write-data-source.js';

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const revision = (source: ReceptionDocumentationSource) =>
  digest([source.id, source.number, source.supplier, source.date, source.dueAt, source.amount, source.reason, source.version]);
const cents = (value: number) => Math.round(value * 100);
const hasControlCharacter = (value: string) => [...value].some((character) => {
  const code = character.charCodeAt(0);
  return code < 32 || code === 127;
});

const invalid = (message: string) => new ApplicationError(message, 'PURCHASE_RECEPTION_DOCUMENTATION_INVALID', 422);

export class ManagePurchaseReceptionDocumentation {
  constructor(private readonly storage: PurchaseReceptionDocumentationDataSource) {}

  async preview(companyId: number, receiptId: number) {
    const source = await this.storage.source(companyId, receiptId);
    if (!source) throw new NotFoundError('Recepción de compra');
    return source.recorded ?? {
      reception: { id: source.id, number: source.number }, amount: source.amount, revision: revision(source),
      canWrite: !source.reason, reason: source.reason, documents: [],
    };
  }

  async save(actor: PurchaseReceptionActor, receiptId: number, input: ReceptionDocumentationInput) {
    const documents = input.documents.map(({ number, amount }) => ({ number: number.trim(), amount }));
    if (documents.length < 1 || documents.length > 4 || documents.some(({ number, amount }) =>
      !number || number.length > 13 || hasControlCharacter(number) || amount <= 0
      || !Number.isSafeInteger(cents(amount)) || Number(amount.toFixed(2)) !== amount)) {
      throw invalid('Captura de uno a cuatro folios con importe positivo de hasta dos decimales.');
    }
    if (new Set(documents.map(({ number }) => number.toUpperCase())).size !== documents.length) {
      throw invalid('Cada folio debe ser distinto.');
    }
    const amount = documents.reduce((total, document) => total + cents(document.amount), 0);
    const request = { ...input, requestKey: input.requestKey.toLowerCase(), documents };
    return this.storage.commit({
      actor, receiptId, input: request, fingerprint: digest([actor.userId, receiptId, request.revision, documents]),
      validate: (source) => {
        if (source.recorded || source.reason) {
          throw new ConflictError(source.recorded?.reason ?? source.reason ?? 'La recepción ya está documentada.',
            'PURCHASE_RECEPTION_DOCUMENTATION_BLOCKED');
        }
        if (documents.some(({ number }) => number.toUpperCase() === source.number.toUpperCase())) {
          throw invalid('Un folio de destino coincide con el de la recepción.');
        }
        if (revision(source) !== input.revision) {
          throw new ConflictError('La recepción cambió. Vuelve a consultar el saldo y captura los folios.',
            'PURCHASE_RECEPTION_DOCUMENTATION_STALE');
        }
        if (amount !== cents(source.amount)) throw invalid('La suma debe ser igual al saldo de la recepción.');
      },
    });
  }
}
